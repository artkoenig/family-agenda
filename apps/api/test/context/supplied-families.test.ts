import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { FileBlobStore, parseFamilyId, postgresSchema, type FamilyId, type PostgresConnection } from "@family-agenda/adapters";
import { drizzle } from "drizzle-orm/pglite";
import { openAgendaAccess } from "@family-agenda/application";
import type { BlobRef } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootShared, type Application } from "../../src/composition-root";
import { contextHeader, expirySkewMs, openContext, sealContext, type Context } from "../../src/context/context";
import { SuppliedFamilies } from "../../src/context/supplied-families";
import { suppliedFetch, type FamilyFetch } from "../../src/context/supplied-http";
import { createHttpApp } from "../../src/http/app";
import { FakeClock } from "../support/fake-clock";
import { acquirePostgres, type InProcessPostgres } from "../support/in-process-postgres";
import { photos } from "../support/photos";
import { ScriptedIdentityProviderClient } from "../support/scripted-identity-provider";

const contextKey = "a-context-key-of-at-least-32-characters";
const idleMs = 60_000;

describe("a core in supplied mode", () => {
  let directory: string;
  let databases: Map<string, InProcessPostgres>;
  let now: number;
  let opened: string[];
  let closed: string[];
  let seen: Request[];
  let warnings: string[];
  let families: SuppliedFamilies;
  let fetch: (request: Request) => Promise<Response>;
  let a: Context;
  let b: Context;
  let provider: ScriptedIdentityProviderClient;

  const familyOf = async (name: string, settings: Partial<Context> = {}): Promise<Context> => {
    const database = await acquirePostgres();
    const familyId = randomUUID() as FamilyId;
    // Databases come from one snapshot, and so with the same Family id at first.
    await database.query(`update family set family_id = '${familyId}'`);
    databases.set(`postgres://${name}`, database);
    return {
      familyId,
      databaseUrl: `postgres://${name}`,
      familyKey: randomBytes(32).toString("base64url"),
      blobDirectory: join(directory, "blobs"),
      timeZone: "Europe/Berlin",
      publicUrl: "http://core",
      expiresAt: now + 3_600_000,
      ...settings,
    };
  };

  /** Databases that are not a test Instance's, such as an empty one. */
  let others: Map<string, PGlite>;

  const connectDatabase = (databaseUrl: string): PostgresConnection => {
    const other = others.get(databaseUrl);
    if (other) {
      opened.push(databaseUrl);
      const migrate = () => Promise.reject(new Error("never migrated on opening"));
      return { db: drizzle(other, { schema: postgresSchema }), migrate, close: () => Promise.resolve(void closed.push(databaseUrl)) };
    }
    const database = databases.get(databaseUrl);
    if (!database) throw new Error("no such database");
    opened.push(databaseUrl);
    const connection = database.connect();
    return { ...connection, close: () => Promise.resolve(void closed.push(databaseUrl)) };
  };

  const request = (context: Context | string | null, path = "/setup", init: RequestInit = {}) =>
    fetch(
      new Request(`http://core${path}`, {
        ...init,
        headers: { ...(context === null ? {} : { [contextHeader]: typeof context === "string" ? context : sealContext(contextKey, context) }), ...(init.headers as Record<string, string>) },
      }),
    );

  /** Runs `fn` on the Application `context` opens, as a request would. */
  const on = async <R,>(context: Context, fn: (application: Application) => Promise<R>): Promise<R> => {
    const sealed = openContext(contextKey, sealContext(contextKey, context), now);
    if (sealed === null) throw new Error("the Context does not open");
    const opening = await families.serve(sealed, (family) => fn(family.application));
    if (!opening.ok) throw new Error(opening.problem);
    return opening.family;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-agenda-supplied-"));
    databases = new Map();
    others = new Map();
    now = Date.parse("2026-09-14T07:00:00Z");
    opened = [];
    closed = [];
    seen = [];
    warnings = [];
    const shared = await bootShared({ tessdataDirectory: join(directory, "tessdata"), bundledTessdataDirectory: null, clock: new FakeClock(new Date(now)) });
    provider = new ScriptedIdentityProviderClient();
    families = new SuppliedFamilies({
      shared,
      settings: { identityProviderClient: provider },
      connectDatabase,
      idleMs,
      now: () => now,
      serving: (application, context) => {
        const app = createHttpApp(application, { trustProxy: false, publicUrl: context.publicUrl, agendaAccess: openAgendaAccess });
        const serve: FamilyFetch = (incoming, env) => {
          seen.push(incoming);
          return app.fetch(incoming, env as never);
        };
        return serve;
      },
    });
    fetch = suppliedFetch({ contextKey, families, version: "test", log: { warn: (message) => warnings.push(message) }, now: () => now });
    a = await familyOf("a");
    b = await familyOf("b");
  });

  afterEach(async () => {
    await families.close();
    for (const database of databases.values()) await database.release();
    for (const other of others.values()) await other.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("answers a request with the Context of Family A from A's data only, and one of B from B's, through one core", async () => {
    await on(a, (application) => application.familyMembers.add({ name: "Mia" }));
    await on(a, (application) => application.admins.enterAdmin({ email: "anna@example.org" }));

    expect((await request(a)).status).toBe(404);
    expect((await request(b)).status).toBe(200);
    expect(await on(a, (application) => application.familyMembers.list())).toMatchObject([{ name: "Mia" }]);
    expect(await on(b, (application) => application.familyMembers.list())).toEqual([]);
    expect(await on(b, (application) => Promise.resolve(application.familyId))).toBe(b.familyId);
  });

  it.each<[string, () => Context | string | null]>([
    ["without a Context", () => null],
    ["with an expired one", () => ({ ...a, expiresAt: now - expirySkewMs })],
    ["with an altered one", () => `${sealContext(contextKey, a).slice(0, -2)}AA`],
    ["with one sealed with another key", () => sealContext("another-context-key-of-at-least-32-chars", a)],
    ["with a Context in the query instead of its header", () => null],
  ])("refuses a request %s and opens nothing", async (_, contextOf) => {
    const answer = await request(contextOf(), `/setup?context=${sealContext(contextKey, a)}`);

    expect(answer.status).toBe(401);
    expect(await answer.text()).not.toContain(a.databaseUrl);
    expect(opened).toEqual([]);
    expect(families.size).toBe(0);
    expect(warnings).toEqual(["Refused a request without a valid Context"]);
  });

  it("refuses a Context whose Family id differs from the one in the database it names", async () => {
    const answer = await request({ ...a, familyId: b.familyId });

    expect(answer.status).toBe(403);
    expect(families.size).toBe(0);
    expect(warnings.join()).not.toContain(a.familyKey);
    expect(warnings.join()).not.toContain(a.databaseUrl);
    // The Family A itself still opens.
    expect((await request(a)).status).toBe(200);
  });

  it("answers 503 for a database it cannot reach, and tries again with the next request", async () => {
    const lost = { ...a, databaseUrl: "postgres://lost" };
    expect((await request(lost)).status).toBe(503);
    expect(warnings).toEqual([`Could not open the Family ${a.familyId} from its Context: unavailable (Error)`]);
    expect(families.size).toBe(0);
  });

  it("cannot read a Source credential stored under one Family's key with another Family's key", async () => {
    const ref = await on(a, (application) => application.secrets.put("imap password"));
    expect(await on(a, (application) => application.secrets.get(ref))).toBe("imap password");

    await expect(on({ ...a, familyKey: b.familyKey }, (application) => application.secrets.get(ref))).rejects.toThrow();
    expect(await on(b, (application) => application.secrets.get(ref))).toBeNull();
  });

  it("keeps a blob of one Family in that Family's folder, where another Family does not find it", async () => {
    const mia = await on(a, (application) => application.familyMembers.add({ name: "Mia", photo: photos.png }));
    if (!mia.ok) throw new Error("not added");

    expect(await readdir(a.blobDirectory)).toEqual([a.familyId]);
    const [ref] = await readdir(join(a.blobDirectory, a.familyId));
    expect(await new FileBlobStore(a.blobDirectory, parseFamilyId(a.familyId)!).get(ref as BlobRef)).not.toBeNull();
    expect(await new FileBlobStore(b.blobDirectory, parseFamilyId(b.familyId)!).get(ref as BlobRef)).toBeNull();
    expect(await on(b, (application) => application.familyMembers.photo(mia.id))).toBeNull();
  });

  it("opens a Family once for its requests, resealed or not, and closes it once idle", async () => {
    await request(a);
    await request({ ...a, expiresAt: a.expiresAt + 1 });
    expect(opened).toEqual([a.databaseUrl]);

    now += idleMs - 1;
    await request(b);
    expect(closed).toEqual([]);
    // The next request after the idle time, of another Family, closes A on the core's clock.
    now += 1;
    await request(b);
    expect(closed).toEqual([a.databaseUrl]);
    expect(families.size).toBe(1);

    await request(a);
    expect(opened).toEqual([a.databaseUrl, b.databaseUrl, a.databaseUrl]);
    await families.close();
    expect(closed.sort()).toEqual([a.databaseUrl, a.databaseUrl, b.databaseUrl]);
  });

  it("refuses a Context naming an empty database, writing nothing to it", async () => {
    const empty = await PGlite.create();
    others.set("postgres://empty", empty);

    const answer = await request({ ...a, databaseUrl: "postgres://empty" });

    expect(answer.status).toBe(409);
    expect(await answer.text()).toContain("family-not-prepared");
    expect(closed).toEqual(["postgres://empty"]);
    expect((await empty.query("select count(*)::int as n from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')")).rows).toEqual([{ n: 0 }]);
  });

  it("refuses a Context naming a database this version has not prepared, migrating nothing", async () => {
    const behind = await PGlite.create();
    others.set("postgres://behind", behind);
    await behind.exec("create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint); insert into drizzle.__drizzle_migrations (hash) values ('an older migration')");

    expect((await request({ ...a, databaseUrl: "postgres://behind" })).status).toBe(409);
    expect((await behind.query("select hash from drizzle.__drizzle_migrations")).rows).toEqual([{ hash: "an older migration" }]);
    expect((await behind.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'")).rows).toEqual([{ n: 0 }]);
    expect(families.size).toBe(0);
  });

  it("leaves the shared blob directory as it is on opening: no blobs of the earlier layout are moved", async () => {
    await mkdir(a.blobDirectory);
    const stray = randomUUID();
    await writeFile(join(a.blobDirectory, stray), "a blob of the layout before Family folders");

    expect((await request(a)).status).toBe(200);
    expect((await request({ ...a, familyId: b.familyId })).status).toBe(403);
    expect(await readdir(a.blobDirectory)).toEqual([stray]);
  });

  it("hands the Family's pages the request without its Context, and answers with none", async () => {
    const answer = await request(a, "/setup", { method: "POST", body: new URLSearchParams({ email: "x" }), headers: { origin: "http://core", "content-type": "application/x-www-form-urlencoded" } });

    expect(seen.map((incoming) => incoming.headers.get(contextHeader))).toEqual([null]);
    expect([...answer.headers.values()].join()).not.toContain("v1.");
  });

  it("answers the health check without a Context, opening nothing", async () => {
    const answer = await request(null, "/api/health");
    expect(await answer.json()).toEqual({ status: "ok", version: "test" });
    expect(opened).toEqual([]);
  });

  describe("with the settings of each Family's own Context", () => {
    const password = "correct horse battery";
    const cookieOf = (response: Response, name: string) => {
      const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`)) ?? "";
      return { pair: header.split(";")[0] ?? "", path: /Path=([^;]*)/i.exec(header)?.[1] };
    };
    const form = (fields: Record<string, string>): RequestInit => ({
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { origin: "http://core", "content-type": "application/x-www-form-urlencoded" },
    });
    const anna = { subject: "sub-anna", email: "anna@example.org", emailVerified: true, groups: ["homelab-admin"] };
    const identityProvider = { issuerUrl: "https://id.example.org", clientId: "family-agenda", clientSecret: "s3cret-of-a" };

    it("shows each Family its Agenda's days in its own time zone", async () => {
      // The core's clock says 07:00 in UTC on Monday: Monday in Berlin, still Sunday in Pago Pago.
      const berlin = await familyOf("berlin", { timeZone: "Europe/Berlin" });
      const pagoPago = await familyOf("pago-pago", { timeZone: "Pacific/Pago_Pago" });
      const dayOf = async (context: Context) => {
        expect(await on(context, (application) => Promise.resolve(application.timeZone))).toBe(context.timeZone);
        const created = await on(context, (application) => application.agendas.create({ memberIds: [], horizonDays: 1 }));
        if (!created.ok) throw new Error(created.problem);
        const page = await on(context, (application) => application.agendas.open(created.id, { access: openAgendaAccess }));
        return page?.layout === "timeline" ? page.days.map((day) => day.date) : null;
      };

      expect(await dayOf(berlin)).toEqual(["2026-09-14"]);
      expect(await dayOf(pagoPago)).toEqual(["2026-09-13"]);
    });

    it("emits each Family's links, redirects, cookies, web manifest and Agenda feed below its own prefix", async () => {
      const first = await familyOf("first", { publicUrl: "https://first.example.org/one" });
      const second = await familyOf("second", { publicUrl: "https://second.example.org/two/" });

      for (const [context, prefix, origin] of [[first, "/one", "https://first.example.org"], [second, "/two", "https://second.example.org"]] as const) {
        expect((await request(context, "/admin")).headers.get("location")).toBe(`${prefix}/setup`);
        expect(await (await request(context, "/setup")).text()).toContain(`action="${prefix}/setup"`);
        const created = await request(context, "/setup", form({ email: "anna@example.org", password }));
        expect(created.headers.get("location")).toBe(`${prefix}/admin/recovery-kit`);
        expect(cookieOf(created, "fb_session").path).toBe(prefix);
        const agenda = await on(context, (application) => application.agendas.create({ memberIds: [], horizonDays: 3 }));
        if (!agenda.ok) throw new Error(agenda.problem);
        const manifest = (await (await request(context, `/agendas/${agenda.id}/manifest.webmanifest`)).json()) as { start_url: string; scope: string };
        expect(manifest.start_url).toMatch(new RegExp(`^${prefix}/agendas/${agenda.id}`));
        // The feed itself answers, and the Admin area hands out its address below the prefix.
        expect((await request(context, `/agendas/${agenda.id}/feed.ics`)).status).toBe(200);
        await on(context, (application) => application.recoveryKit.confirm());
        const editing = await (await request(context, `/admin/agendas/${agenda.id}`, { headers: { cookie: cookieOf(created, "fb_session").pair } })).text();
        expect(editing).toContain(`href="${origin}${prefix}/agendas/${agenda.id}/feed.ics"`);
      }
    });

    it("offers single sign-on to a Family whose Context names an Identity Provider, through it, and not to one whose Context names none", async () => {
      const offered = await familyOf("offered", { publicUrl: "http://core/one", identityProvider });
      const without = await familyOf("without", { publicUrl: "http://core/two" });

      expect(await (await request(without, "/setup")).text()).not.toContain("/sso/start");
      expect((await request(without, "/sso/start")).headers.get("location") ?? "").not.toContain("id.example.org");
      expect(await (await request(offered, "/setup")).text()).toContain(`href="/one/sso/start"`);

      const start = await request(offered, "/sso/start");
      expect(provider.begun).toEqual([{ connection: identityProvider, redirectUri: "http://core/one/sso/callback" }]);
      const sso = cookieOf(start, "fb_sso");
      expect(sso.path).toBe("/one/sso");
      const pending = JSON.parse(decodeURIComponent(sso.pair.split("=").slice(1).join("="))) as Parameters<typeof provider.returnWith>[0];
      const back = await request(offered, `/sso/callback${provider.returnWith(pending, anna)}`, { headers: { cookie: sso.pair } });

      expect(back.headers.get("location")).toBe("/one/admin/recovery-kit");
      expect(cookieOf(back, "fb_session").path).toBe("/one");
      expect(await on(offered, (application) => application.admins.listAdmins())).toMatchObject([{ email: "anna@example.org" }]);
      expect(warnings.join()).not.toContain("s3cret");
    });

    it("opens a Family anew for a Context with other settings, and keeps it apart from the one opened before", async () => {
      await request(a);
      await request({ ...a, publicUrl: "http://core/elsewhere" });
      await request({ ...a, identityProvider: { ...identityProvider, issuerUrl: "http://core" } });
      await request({ ...a, identityProvider: { ...identityProvider, clientSecret: "another" } });
      await request({ ...a, timeZone: "Asia/Tokyo" });
      expect(families.size).toBe(5);

      expect((await request({ ...a, publicUrl: "http://core/elsewhere" }, "/admin")).headers.get("location")).toBe("/elsewhere/setup");
      expect((await request(a, "/admin")).headers.get("location")).toBe("/setup");
      expect(families.size).toBe(5);
    });

    it("refuses a Context with incomplete Identity Provider settings, naming what is missing, and opens nothing", async () => {
      const answer = await request({ ...a, identityProvider: { issuerUrl: identityProvider.issuerUrl, clientId: "family-agenda" } as NonNullable<Context["identityProvider"]> });

      expect(answer.status).toBe(400);
      expect(await answer.text()).toContain("identityProvider.clientSecret must be set");
      expect(warnings).toEqual(["Refused a Context with settings the core does not take: identityProvider.clientSecret must be set when identityProvider.issuerUrl is"]);
      expect(opened).toEqual([]);
    });
  });
});
