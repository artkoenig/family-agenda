import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { FileBlobStore, migrateFamily, migrationsFolder, parseFamilyId, postgresSchema, refuseNewerMigrationHistory, refuseOldMigrationHistory, type FamilyId, type PostgresConnection } from "@family-agenda/adapters";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as migrateUpTo } from "drizzle-orm/pglite/migrator";
import { openAgendaAccess } from "@family-agenda/application";
import type { BlobRef } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootShared, type Application } from "../../src/composition-root";
import { contextHeader, expirySkewMs, openContext, sealContext, sealUncheckedContext, type Context } from "../../src/context/context";
import { handoverLifetimeMs, signInStateLifetimeMs, SignInRelay } from "../../src/context/sign-in-relay";
import { SuppliedFamilies } from "../../src/context/supplied-families";
import { suppliedFetch, type FamilyFetch } from "../../src/context/supplied-http";
import { createHttpApp } from "../../src/http/app";
import { FakeClock } from "../support/fake-clock";
import { FakeTessdataCatalog } from "../support/fake-tessdata-catalog";
import { acquirePostgres, type InProcessPostgres } from "../support/in-process-postgres";
import { photos } from "../support/photos";
import { ScriptedIdentityProviderClient } from "../support/scripted-identity-provider";

const contextKey = "a-context-key-of-at-least-32-characters";
const idleMs = 60_000;
const preparingWaitMs = 200;
const schemaCheckMs = 5_000;

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
  let catalog: FakeTessdataCatalog;
  const identityProvider = { issuerUrl: "https://id.example.org", clientId: "family-agenda", clientSecret: "s3cret-of-a" };
  const callbackUrl = "https://sign-in.example.org/sso/return";

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
  /** The databases named here migrate only once the promise settles. */
  let migrationsHeld: Map<string, Promise<void>>;
  /** The databases migrated, once for each migration. */
  let migrated: string[];

  const connectDatabase = (databaseUrl: string): PostgresConnection => {
    const other = others.get(databaseUrl);
    if (other) {
      opened.push(databaseUrl);
      const db = drizzle(other, { schema: postgresSchema });
      const migrate = async (options: { familyId?: FamilyId } = {}) => {
        await migrationsHeld.get(databaseUrl);
        // As a Postgres connection migrates: refusing the history of another release first.
        await refuseOldMigrationHistory(db, migrationsFolder);
        await refuseNewerMigrationHistory(db, migrationsFolder);
        migrated.push(databaseUrl);
        await migrateFamily(db, migrationsFolder, options.familyId);
      };
      return { db, migrate, close: () => Promise.resolve(void closed.push(databaseUrl)) };
    }
    const database = databases.get(databaseUrl);
    if (!database) throw new Error("no such database");
    opened.push(databaseUrl);
    const connection = database.connect();
    return { ...connection, close: () => Promise.resolve(void closed.push(databaseUrl)) };
  };

  const request = (context: Context | string | null, path = "/admin/sign-in", init: RequestInit = {}) =>
    fetch(
      // At the Family's own host, as the caller forwards it.
      new Request(`${typeof context === "object" && context !== null ? new URL(context.publicUrl).origin : "http://core"}${path}`, {
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
    migrationsHeld = new Map();
    migrated = [];
    now = Date.parse("2026-09-14T07:00:00Z");
    opened = [];
    closed = [];
    seen = [];
    warnings = [];
    catalog = new FakeTessdataCatalog();
    const shared = await bootShared({ tessdataDirectory: join(directory, "tessdata"), bundledTessdataDirectory: null, tessdataCatalog: catalog, clock: new FakeClock(new Date(now)),
      // The deployment's registration, open as with `FAMILY_WEBHOOK_URL` set (ADR-0010).
      registration: { isOpen: () => Promise.resolve(true), register: () => Promise.resolve() },
    });
    provider = new ScriptedIdentityProviderClient();
    const supplied = { ...identityProvider, requiredGroup: "homelab-admin", groupsClaim: "groups", familyIdClaim: "custom_data.familyId", callbackUrl };
    const relay = new SignInRelay({ contextKey, identityProvider: supplied, client: provider, now: () => now });
    families = new SuppliedFamilies({
      shared,
      settings: { identityProviderClient: provider },
      identityProvider: supplied,
      connectDatabase,
      idleMs,
      preparingWaitMs,
      schemaCheckMs,
      now: () => now,
      serving: (application, context) => {
        const app = createHttpApp(application, { trustProxy: false, publicUrl: context.publicUrl, agendaAccess: openAgendaAccess, signInRelay: relay.forFamily(context) });
        const serve: FamilyFetch = (incoming, env) => {
          seen.push(incoming);
          return app.fetch(incoming, env as never);
        };
        return serve;
      },
    });
    const signInCallback = { path: relay.callbackPath, answer: (incoming: Request) => relay.callback(incoming) };
    fetch = suppliedFetch({ contextKey, families, version: "test", log: { warn: (message) => warnings.push(message) }, signInCallback, now: () => now });
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

    expect((await request(a)).status).toBe(200);
    expect((await request(b)).status).toBe(200);
    expect(await on(a, (application) => application.familyMembers.list())).toMatchObject([{ name: "Mia" }]);
    expect(await on(b, (application) => application.familyMembers.list())).toEqual([]);
    expect(await on(b, (application) => Promise.resolve(application.familyId))).toBe(b.familyId);
  });

  it("keeps an OCR model one Family removes for another that still reads with it, and downloads nothing it already has", async () => {
    expect(await on(a, (application) => application.languages.addOcrLanguage("fra"))).toEqual({ ok: true });
    catalog.fail("fra", "unreachable");
    expect(await on(b, (application) => application.languages.addOcrLanguage("fra"))).toEqual({ ok: true });

    expect(await on(a, (application) => application.languages.removeOcrLanguage("fra"))).toEqual({ ok: true });

    expect(await readdir(join(directory, "tessdata"))).toContain("fra.traineddata");
    const settings = await on(b, (application) => application.languages.current());
    expect(settings.ocrLanguages).toContainEqual({ language: "fra", installed: true });
    expect((await on(a, (application) => application.languages.current())).ocrLanguages.map((ocr) => ocr.language)).not.toContain("fra");
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

  describe("with the Family's organization in its Context", () => {
    const organizationOf = async (context: Context) => (await databases.get(context.databaseUrl)!.query("select organization_id from family"))[0]?.organization_id;

    it("records it on opening while the database has none, for sign-in to find", async () => {
      const withOrganization = { ...a, organizationId: "org-a" };

      expect((await request(withOrganization)).status).toBe(200);

      expect(await organizationOf(a)).toBe("org-a");
      expect(await on(withOrganization, (application) => application.singleSignOn.organizationId())).toBe("org-a");
    });

    it("records it on the opening that prepares an empty database", async () => {
      others.set("postgres://empty", await PGlite.create());
      const empty = { ...a, databaseUrl: "postgres://empty", organizationId: "org-a" };

      expect((await request(empty)).status).toBe(200);

      expect(await on(empty, (application) => application.singleSignOn.organizationId())).toBe("org-a");
    });

    it("refuses one that differs from the organization recorded, writing nothing", async () => {
      await request({ ...a, organizationId: "org-a" });

      const answer = await request({ ...b, ...a, organizationId: "org-b" });

      expect(answer.status).toBe(403);
      expect(await organizationOf(a)).toBe("org-a");
      expect(warnings.join()).toContain("organization-id-differs");
    });

    it("keeps the organization recorded for a Context without one", async () => {
      await request({ ...a, organizationId: "org-a" });

      expect((await request(a)).status).toBe(200);
      expect(await organizationOf(a)).toBe("org-a");
    });
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

  it("prepares an empty database on opening, with the Context's Family id, and then serves the request", async () => {
    others.set("postgres://empty", await PGlite.create());
    const empty = { ...a, databaseUrl: "postgres://empty", familyId: randomUUID() as FamilyId };

    const answer = await request(empty);

    expect(answer.status).toBe(200);
    expect(await on(empty, (application) => Promise.resolve(application.familyId))).toBe(empty.familyId);
    expect(migrated).toEqual(["postgres://empty"]);
  });

  /** A database as an older release left it: migrated up to, not including, this release's last migration. */
  const preparedByOlderRelease = async (): Promise<PGlite> => {
    const folder = join(directory, "older-release");
    await cp(migrationsFolder, folder, { recursive: true });
    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: unknown[] };
    await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, -1) }));
    const older = await PGlite.create();
    await migrateUpTo(drizzle(older), { migrationsFolder: folder });
    return older;
  };

  it("prepares a database an older release prepared on opening, and then serves the request", async () => {
    const older = await preparedByOlderRelease();
    others.set("postgres://older", older);
    const [stored] = (await older.query<{ id: FamilyId }>("select family_id::text as id from family")).rows;
    const behind = { ...a, databaseUrl: "postgres://older", familyId: stored!.id };

    expect((await request(behind)).status).toBe(200);
    expect(migrated).toEqual(["postgres://older"]);
    expect((await older.query("select family_id::text as id from family")).rows).toEqual([{ id: behind.familyId }]);
  });

  it("refuses a database a newer release migrated with an answer of its own, writing nothing to it", async () => {
    const newer = await PGlite.create();
    others.set("postgres://newer", newer);
    const ahead = { ...a, databaseUrl: "postgres://newer", familyId: randomUUID() as FamilyId };
    expect((await request(ahead)).status).toBe(200);
    await families.close();
    await newer.exec("insert into drizzle.__drizzle_migrations (hash, created_at) values ('of a newer release', 0)");
    const before = (await newer.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows;

    const answer = await request(ahead);

    expect(answer.status).toBe(409);
    expect(await answer.text()).toContain("migrated-by-newer-release");
    expect((await newer.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows).toEqual(before);
    expect(families.size).toBe(0);
  });

  it("notices a newer release migrating a Family it has open, and refuses it from then on", async () => {
    const newer = await PGlite.create();
    others.set("postgres://newer", newer);
    const open = { ...a, databaseUrl: "postgres://newer", familyId: randomUUID() as FamilyId };
    expect((await request(open)).status).toBe(200);
    await newer.exec("insert into drizzle.__drizzle_migrations (hash, created_at) values ('of a newer release', 0)");

    // Checked again at most every few seconds, not on every request.
    now += schemaCheckMs - 1;
    expect((await request(open)).status).toBe(200);
    now += 1;
    const answer = await request(open);

    expect(answer.status).toBe(409);
    expect(await answer.text()).toContain("migrated-by-newer-release");
    expect(families.size).toBe(0);
    expect(closed).toContain("postgres://newer");
  });

  it("refuses a database of the data model before the rebuild, writing nothing to it", async () => {
    const old = await PGlite.create();
    others.set("postgres://old", old);
    await old.exec("create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint); insert into drizzle.__drizzle_migrations (hash) values ('of the old data model')");

    const answer = await request({ ...a, databaseUrl: "postgres://old" });

    expect(answer.status).toBe(409);
    expect(await answer.text()).toContain("old-data-model");
    expect((await old.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'")).rows).toEqual([{ n: 0 }]);
    expect(migrated).toEqual([]);
  });

  const held = (databaseUrl: string) => {
    let release = () => {};
    migrationsHeld.set(databaseUrl, new Promise<void>((resolve) => (release = resolve)));
    return release;
  };

  it("answers 503 while preparing outlasts the wait of a request, and serves a retry once it is done", async () => {
    others.set("postgres://empty", await PGlite.create());
    const empty = { ...a, databaseUrl: "postgres://empty", familyId: randomUUID() as FamilyId };
    const release = held("postgres://empty");

    const answer = await request(empty);
    expect(answer.status).toBe(503);
    expect(await answer.text()).toContain("migrating");
    // Another request meanwhile waits too, and starts no prepare of its own.
    expect((await request({ ...empty, publicUrl: "http://core/elsewhere" })).status).toBe(503);

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await request(empty)).status).toBe(200);
    expect(migrated).toEqual(["postgres://empty"]);
  });

  it("prepares a database once for requests that open it at once, and serves each after", async () => {
    others.set("postgres://empty", await PGlite.create());
    const empty = { ...a, databaseUrl: "postgres://empty", familyId: randomUUID() as FamilyId };
    const release = held("postgres://empty");

    const answers = Promise.all([request(empty), request(empty), request({ ...empty, publicUrl: "http://core/elsewhere" })]);
    setTimeout(release, 20);

    expect((await answers).map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(migrated).toEqual(["postgres://empty"]);
  });

  it("answers 503 unavailable for a database whose history no release migrates on, rather than waiting on it", async () => {
    const diverged = await PGlite.create();
    others.set("postgres://diverged", diverged);
    const context = { ...a, databaseUrl: "postgres://diverged", familyId: randomUUID() as FamilyId };
    expect((await request(context)).status).toBe(200);
    await families.close();
    await diverged.exec("update drizzle.__drizzle_migrations set hash = 'of another branch' where id = (select max(id) from drizzle.__drizzle_migrations)");

    const answer = await request(context);

    expect(answer.status).toBe(503);
    expect(await answer.text()).not.toContain("migrating");
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
    const cookieOf = (response: Response, name: string) => {
      const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`)) ?? "";
      return { pair: header.split(";")[0] ?? "", path: /Path=([^;]*)/i.exec(header)?.[1] };
    };
    const anna = { subject: "sub-anna", email: "anna@example.org", emailVerified: true, groups: ["homelab-admin"], familyId: null as string | null, organizations: [] as string[] };

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
        expect((await request(context, "/admin")).headers.get("location")).toBe(`${prefix}/sso/start`);
        const session = await on(context, (application) => application.admins.startSession({ subject: "sub-anna", email: "anna@example.org" }));
        expect((await request(context, "/admin", { headers: { cookie: `fb_session=${session}` } })).headers.get("location")).toBe(`${prefix}/admin/recovery-kit`);
        const agenda = await on(context, (application) => application.agendas.create({ memberIds: [], horizonDays: 3 }));
        if (!agenda.ok) throw new Error(agenda.problem);
        const manifest = (await (await request(context, `/agendas/${agenda.id}/manifest.webmanifest`)).json()) as { start_url: string; scope: string };
        expect(manifest.start_url).toMatch(new RegExp(`^${prefix}/agendas/${agenda.id}`));
        // The feed itself answers, and the Admin area hands out its address below the prefix.
        expect((await request(context, `/agendas/${agenda.id}/feed.ics`)).status).toBe(200);
        await on(context, (application) => application.recoveryKit.confirm());
        const editing = await (await request(context, `/admin/agendas/${agenda.id}`, { headers: { cookie: `fb_session=${session}` } })).text();
        expect(editing).toContain(`href="${origin}${prefix}/agendas/${agenda.id}/feed.ics"`);
      }
    });

    /** The browser the Identity Provider sends back to the one callback, as it would follow the redirects. */
    const callback = (query: string) => fetch(new Request(`http://core/sso/return${query}`));
    const begin = async (context: Context) => {
      const start = await request(context, "/sso/start");
      const sso = cookieOf(start, "fb_sso");
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
      return { sso, state, pending: { state, nonce: "", codeVerifier: "" } };
    };
    /** Begins a sign-in at `context`, and returns from the Identity Provider to the one callback as someone of `familyId`. */
    const signIn = async (context: Context, familyId: string | null) => {
      const begun = await begin(context);
      const back = await callback(provider.returnWith(begun.pending, { ...anna, groups: [], familyId }));
      return { ...begun, back };
    };
    /** Follows the handover `location` to the Family's pages, its path prefix removed as the caller does. */
    const handOver = (context: Context, location: string, cookie: string) => {
      const prefix = new URL(context.publicUrl).pathname.replace(/\/$/, "");
      const target = new URL(location);
      return request(context, target.pathname.slice(prefix.length) + target.search, { headers: { cookie } });
    };

    it("signs two Families with different addresses in through the one callback, each into its own Family", async () => {
      const one = await familyOf("one", { publicUrl: "https://one.example.org/one" });
      const two = await familyOf("two", { publicUrl: "https://two.example.org" });

      expect(await (await request(one, "/admin/sign-in")).text()).toContain(`href="/one/sso/start"`);
      for (const context of [one, two]) {
        const { sso, back } = await signIn(context, context.familyId);
        expect(provider.begun.at(-1)).toEqual({ connection: { ...identityProvider, groupsClaim: "groups", familyIdClaim: "custom_data.familyId" }, redirectUri: callbackUrl });
        expect(back.status).toBe(303);
        const location = back.headers.get("location") ?? "";
        expect(location.startsWith(`${context.publicUrl}/sso/handover?token=`)).toBe(true);
        expect(back.headers.get("referrer-policy")).toBe("no-referrer");
        const taken = await handOver(context, location, sso.pair);
        expect(taken.headers.get("location")).toBe(`${new URL(context.publicUrl).pathname.replace(/\/$/, "")}/admin`);
        const session = cookieOf(taken, "fb_session");
        expect(session.path).toBe(new URL(context.publicUrl).pathname);
        expect((await request(context, "/admin", { headers: { cookie: session.pair } })).headers.get("location")).toMatch(/\/admin\/recovery-kit$/);
      }
      expect(warnings.join()).not.toContain("s3cret");
    });

    it("offers no sign-up at a Family: its sign-in page has no Register link, and screen=register starts a plain sign-in", async () => {
      const page = await (await request(a, "/admin/sign-in")).text();
      expect(page).not.toContain("screen=register");
      expect(page).not.toMatch(/>\s*Register\s*</);
      const start = await request(a, "/sso/start?screen=register");
      expect(new URL(start.headers.get("location") ?? "").searchParams.has("first_screen")).toBe(false);
    });

    it("still starts a sign-in from an invitation link, with its one-time token", async () => {
      const start = await request(a, "/sso/start?one_time_token=ott-1&login_hint=carla%40example.org");
      const authorization = new URL(start.headers.get("location") ?? "").searchParams;
      expect([authorization.get("one_time_token"), authorization.get("login_hint")]).toEqual(["ott-1", "carla@example.org"]);
    });

    it("answers the Family's own callback path with nothing in supplied mode: sign-ins return to the one callback", async () => {
      expect((await request(a, "/sso/callback?code=x&state=y")).status).toBe(404);
    });

    it("refuses a token for Family A that returns from a sign-in begun for Family B, naming why on B's sign-in page", async () => {
      const one = await familyOf("one", { publicUrl: "http://core/one" });
      const two = await familyOf("two", { publicUrl: "http://core/two" });

      const foreign = (await signIn(two, one.familyId)).back;
      expect(foreign.headers.get("location")).toBe("http://core/two/admin/sign-in?problem=sso-other-family");
      const page = await request(two, "/admin/sign-in?problem=sso-other-family");
      expect(page.status).toBe(401);
      expect(await page.text()).toContain("belongs to another Family");
      expect((await signIn(two, null)).back.headers.get("location")).toBe("http://core/two/admin/sign-in?problem=sso-no-family");
      // Nothing else is shown from the address.
      expect((await request(two, "/admin/sign-in?problem=%3Cscript%3E")).status).toBe(200);
    });

    it("refuses a handover for Family A at Family B, even with the cookie of the browser that began it", async () => {
      const one = await familyOf("one", { publicUrl: "http://core/one" });
      const two = await familyOf("two", { publicUrl: "http://core/two" });
      const { sso, back } = await signIn(one, one.familyId);

      const taken = await request(two, `/sso/handover${new URL(back.headers.get("location") ?? "").search}`, { headers: { cookie: sso.pair } });
      expect(taken.status).toBe(401);
      expect(cookieOf(taken, "fb_session").pair).toBe("");
    });

    it("refuses a tampered, foreign or expired state, and sends the browser nowhere", async () => {
      const { pending } = await begin(a);
      const [version, iv, ciphertext = "", tag] = pending.state.split(".");
      const tampered = [version, iv, (ciphertext.startsWith("A") ? "B" : "A") + ciphertext.slice(1), tag].join(".");
      for (const state of [tampered, "v1.a.b.c", "", pending.state.replace(/^v1/, "v2")]) {
        const back = await callback(provider.returnWith({ ...pending, state }, { ...anna, familyId: a.familyId }));
        expect(back.status).toBe(400);
        expect(back.headers.get("location")).toBeNull();
      }

      const late = await begin(a);
      now += signInStateLifetimeMs;
      const expired = await callback(provider.returnWith(late.pending, { ...anna, familyId: a.familyId }));
      expect(expired.status).toBe(400);
    });

    it("takes a handover once, only in the browser that began the sign-in, and not after it expired", async () => {
      const first = await signIn(a, a.familyId);
      const location = first.back.headers.get("location") ?? "";

      // Another browser, without the cookie or with one of its own, cannot take it.
      expect((await handOver(a, location, "")).status).toBe(401);
      const other = await begin(a);
      expect((await handOver(a, location, other.sso.pair)).status).toBe(401);
      expect((await handOver(a, location.replace(/token=.{4}/, "token=AAAA"), first.sso.pair)).status).toBe(401);

      const taken = await handOver(a, location, first.sso.pair);
      expect(taken.status).toBe(303);
      expect(taken.headers.get("referrer-policy")).toBe("no-referrer");
      const replayed = await handOver(a, location, first.sso.pair);
      expect(replayed.status).toBe(401);
      expect(cookieOf(replayed, "fb_session").pair).toBe("");

      const second = await signIn(a, a.familyId);
      now += handoverLifetimeMs;
      expect((await handOver(a, second.back.headers.get("location") ?? "", second.sso.pair)).status).toBe(401);
    });

    it("signs out at the Identity Provider too, which returns through the one callback to the Identity Provider's sign-in screen of the Family", async () => {
      const begun = await begin(a);
      const back = await callback(provider.returnWith(begun.pending, { ...anna, groups: [], familyId: a.familyId, idToken: "ey.anna" }));
      const session = cookieOf(await handOver(a, back.headers.get("location") ?? "", begun.sso.pair), "fb_session");

      const signedOut = await request(a, "/admin/sign-out", { method: "POST", headers: { cookie: session.pair, origin: new URL(a.publicUrl).origin } });
      expect(signedOut.status).toBe(303);
      const atProvider = new URL(signedOut.headers.get("location") ?? "");
      expect(`${atProvider.origin}${atProvider.pathname}`).toBe(`${identityProvider.issuerUrl}/session/end`);
      expect(atProvider.searchParams.get("id_token_hint")).toBe("ey.anna");
      expect(atProvider.searchParams.get("post_logout_redirect_uri")).toBe(callbackUrl);
      const returned = await callback(`?state=${encodeURIComponent(atProvider.searchParams.get("state") ?? "")}`);
      expect(returned.status).toBe(303);
      expect(returned.headers.get("location")).toBe(`${a.publicUrl}/sso/start`);

      // A sign-out state is no sign-in state, and expires.
      now += signInStateLifetimeMs;
      expect((await callback(`?state=${encodeURIComponent(atProvider.searchParams.get("state") ?? "")}`)).status).toBe(400);
    });

    it("opens a Family anew for a Context with other settings, and keeps it apart from the one opened before", async () => {
      await request(a);
      await request({ ...a, publicUrl: "http://core/elsewhere" });
      await request({ ...a, timeZone: "Asia/Tokyo" });
      expect(families.size).toBe(3);

      expect((await request({ ...a, publicUrl: "http://core/elsewhere" }, "/admin")).headers.get("location")).toBe("/elsewhere/sso/start");
      expect((await request(a, "/admin")).headers.get("location")).toBe("/sso/start");
      expect(families.size).toBe(3);
    });

    it("refuses a Context naming an Identity Provider, naming it, and opens nothing", async () => {
      const answer = await request(sealUncheckedContext(contextKey, { ...a, identityProvider }));

      expect(answer.status).toBe(400);
      expect(await answer.text()).toContain("identityProvider must not be set");
      expect(warnings).toEqual([expect.stringMatching(/^Refused a Context with settings the core does not take: identityProvider must not be set/)]);
      expect(opened).toEqual([]);
    });
  });
});
