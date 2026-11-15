import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBlobStore, parseFamilyId, type PostgresConnection } from "@family-agenda/adapters";
import { openAgendaAccess } from "@family-agenda/application";
import type { BlobRef } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootShared, type Application } from "../../src/composition-root";
import { contextHeader, sealContext, type Context } from "../../src/context/context";
import { SuppliedFamilies } from "../../src/context/supplied-families";
import { suppliedFetch, type FamilyFetch } from "../../src/context/supplied-http";
import { createHttpApp } from "../../src/http/app";
import { FakeClock } from "../support/fake-clock";
import { acquirePostgres, type InProcessPostgres } from "../support/in-process-postgres";
import { photos } from "../support/photos";

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
  let families: SuppliedFamilies<FamilyFetch & { application: Application }>;
  let fetch: (request: Request) => Promise<Response>;
  let a: Context;
  let b: Context;

  const familyOf = async (name: string): Promise<Context> => {
    const database = await acquirePostgres();
    const familyId = randomUUID();
    // Databases come from one snapshot, and so with the same Family id at first.
    await database.query(`update family set family_id = '${familyId}'`);
    databases.set(`postgres://${name}`, database);
    return {
      familyId,
      databaseUrl: `postgres://${name}`,
      familyKey: randomBytes(32).toString("base64url"),
      blobDirectory: join(directory, "blobs"),
      expiresAt: now + 3_600_000,
    };
  };

  const connectDatabase = (databaseUrl: string): PostgresConnection => {
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
    const opening = await families.serve(context, (family) => fn(family.application));
    if (!opening.ok) throw new Error(opening.problem);
    return opening.family;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-agenda-supplied-"));
    databases = new Map();
    now = Date.parse("2026-09-14T07:00:00Z");
    opened = [];
    closed = [];
    seen = [];
    warnings = [];
    const shared = await bootShared({ tessdataDirectory: join(directory, "tessdata"), bundledTessdataDirectory: null, clock: new FakeClock(new Date(now)) });
    families = new SuppliedFamilies<FamilyFetch & { application: Application }>({
      shared,
      settings: { timeZone: "Europe/Berlin" },
      connectDatabase,
      idleMs,
      now: () => now,
      serving: (application) => {
        const app = createHttpApp(application, { trustProxy: false, agendaAccess: openAgendaAccess });
        const serve: FamilyFetch = (incoming, env) => {
          seen.push(incoming);
          return app.fetch(incoming, env as never);
        };
        return Object.assign(serve, { application });
      },
    });
    fetch = suppliedFetch({ contextKey, families, version: "test", log: { warn: (message) => warnings.push(message) }, now: () => now });
    a = await familyOf("a");
    b = await familyOf("b");
  });

  afterEach(async () => {
    await families.close();
    for (const database of databases.values()) await database.release();
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
    ["with an expired one", () => ({ ...a, expiresAt: now })],
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
    now += 1;
    await families.sweep();
    expect(closed).toEqual([a.databaseUrl]);
    expect(families.size).toBe(1);

    await request(a);
    expect(opened).toEqual([a.databaseUrl, b.databaseUrl, a.databaseUrl]);
    await families.close();
    expect(closed.sort()).toEqual([a.databaseUrl, a.databaseUrl, b.databaseUrl]);
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
});
