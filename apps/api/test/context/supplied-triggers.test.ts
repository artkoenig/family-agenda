import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrateFamily, migrationsFolder, postgresSchema, refuseNewerMigrationHistory, refuseOldMigrationHistory, type FamilyId, type PostgresConnection } from "@family-agenda/adapters";
import { servePlugin } from "@family-agenda/plugin-kit/server";
import type { SourceTypeId } from "@family-agenda/domain";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootShared, type Application } from "../../src/composition-root";
import { contextHeader, openContext, sealContext, type Context } from "../../src/context/context";
import { SuppliedFamilies } from "../../src/context/supplied-families";
import { verifyTicket } from "../../src/egress/ticket";
import { createSuppliedTriggerApp } from "../../src/triggered-operations";
import { FakeClock } from "../support/fake-clock";
import { acquirePostgres, type InProcessPostgres } from "../support/in-process-postgres";
import { testPluginControls, testSourcePlugin } from "../support/test-source-plugin";

const contextKey = "a-context-key-of-at-least-32-characters";
const ticketKey = "a-ticket-key-of-at-least-32-characters";
const token = "s3cret-token";

describe("Triggered operations of a core in supplied mode", () => {
  let plugin: Server;
  let directory: string;
  let clock: FakeClock;
  let databases: Map<string, InProcessPostgres>;
  let empties: Map<string, PGlite>;
  /** Holds the migrations of the databases named here until the promise settles. */
  let migrationsHeld: Map<string, Promise<void>>;
  let opened: string[];
  let warnings: string[];
  let families: SuppliedFamilies;
  let shared: Awaited<ReturnType<typeof bootShared>>;
  let app: ReturnType<typeof createSuppliedTriggerApp>;
  let a: Context;
  let b: Context;

  beforeAll(async () => {
    plugin = await servePlugin(testSourcePlugin({ sourceTypeId: "ics", configuration: { version: 1, fields: [{ key: "url", label: "Address", secret: true, required: true }] } }), { host: "127.0.0.1" });
  });
  afterAll(async () => {
    await new Promise((resolve) => plugin.close(resolve));
  });

  const contextOf = (databaseUrl: string, familyId: FamilyId, settings: Partial<Context> = {}): Context => ({
    familyId,
    databaseUrl,
    familyKey: randomBytes(32).toString("base64url"),
    blobDirectory: join(directory, "blobs"),
    timeZone: "Europe/Berlin",
    publicUrl: "http://core",
    expiresAt: Date.now() + 3_600_000,
    ...settings,
  });

  const familyOf = async (name: string): Promise<Context> => {
    const database = await acquirePostgres();
    const familyId = randomUUID() as FamilyId;
    // Databases come from one snapshot, and so with the same Family id at first.
    await database.query(`update family set family_id = '${familyId}'`);
    databases.set(`postgres://${name}`, database);
    return contextOf(`postgres://${name}`, familyId);
  };

  const connectDatabase = (databaseUrl: string): PostgresConnection => {
    opened.push(databaseUrl);
    const empty = empties.get(databaseUrl);
    if (empty) {
      const db = drizzle(empty, { schema: postgresSchema });
      const migrate = async (options: { familyId?: FamilyId } = {}) => {
        await migrationsHeld.get(databaseUrl);
        // As a Postgres connection migrates: refusing the history of another release first.
        await refuseOldMigrationHistory(db, migrationsFolder);
        await refuseNewerMigrationHistory(db, migrationsFolder);
        await migrateFamily(db, migrationsFolder, options.familyId);
      };
      return { db, migrate, close: () => Promise.resolve() };
    }
    const database = databases.get(databaseUrl);
    if (!database) throw new Error("no such database");
    return database.connect();
  };

  const trigger = async (name: string, context: Context | string | null, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }) => {
    const response = await app.request(`/operations/${name}`, {
      method: "POST",
      headers: { ...headers, ...(context === null ? {} : { [contextHeader]: typeof context === "string" ? context : sealContext(contextKey, context) }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const on = async <R,>(context: Context, fn: (application: Application) => Promise<R>): Promise<R> => {
    const sealed = openContext(contextKey, sealContext(contextKey, context), Date.now());
    if (sealed === null) throw new Error("the Context does not open");
    const opening = await families.serve(sealed, (family) => fn(family.application));
    if (!opening.ok) throw new Error(opening.problem);
    return opening.family;
  };

  const addSource = async (context: Context, url: string) => {
    await on(context, (application) => application.sourceTypes.enable("ics"));
    const added = await on(context, (application) => application.sources.add({ sourceTypeId: "ics", plain: {}, secrets: { url } }));
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    return added.id;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-agenda-supplied-triggers-"));
    clock = new FakeClock(new Date("2026-09-14T07:00:00Z"));
    databases = new Map();
    empties = new Map();
    migrationsHeld = new Map();
    opened = [];
    warnings = [];
    shared = await bootShared({
      tessdataDirectory: join(directory, "tessdata"),
      bundledTessdataDirectory: null,
      clock,
      egressTicketKey: ticketKey,
      pluginContainers: [{ sourceTypeId: "ics" as SourceTypeId, url: `http://127.0.0.1:${(plugin.address() as AddressInfo).port}` }],
    });
    families = new SuppliedFamilies({ shared, connectDatabase, serving: () => () => new Response("page") });
    app = createSuppliedTriggerApp({ token, contextKey, families, log: { warn: (line) => void warnings.push(line), error: () => {} } });
    a = await familyOf("a");
    b = await familyOf("b");
  });

  afterEach(async () => {
    await families.close();
    for (const database of databases.values()) await database.release();
    for (const empty of empties.values()) await empty.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("runs the due work of the Context's Family only, its plugin calls ticketed for it", async () => {
    const ofA = await addSource(a, "https://a.example.org/a.ics");
    const ofB = await addSource(b, "https://b.example.org/b.ics");
    const before = testPluginControls.runs("ics").length;
    clock.advance(60 * 60_000);

    const answer = await trigger("due-work", a);

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ polled: { ok: true, report: { ran: [ofA] } } });
    const tickets = testPluginControls.runs("ics").slice(before).map((run) => verifyTicket(ticketKey, decodeURIComponent(new URL(run.egressProxy).password), Date.now()));
    expect(tickets.map((ticket) => [ticket?.familyId, ticket?.sourceId])).toEqual([[a.familyId, ofA]]);
    expect(tickets.map((ticket) => ticket?.sourceId)).not.toContain(ofB);
  });

  it("purges and sweeps in the Context's Family only, and manages no Admins", async () => {
    expect(await trigger("purge", a)).toEqual({ status: 200, body: { purged: 0, deleted: 0 } });
    expect(await trigger("secret-sweep", b)).toEqual({ status: 200, body: { removed: 0 } });
    for (const name of ["enter-admin", "reset-admin-password"]) {
      expect(await trigger(name, a, { email: "anna@example.org" })).toEqual({ status: 404, body: { error: "unknown-operation" } });
    }
  });

  it("prepares an empty database on opening it for an operation, with the Context's Family id, and then runs the operation", async () => {
    empties.set("postgres://empty", await PGlite.create());
    const empty = contextOf("postgres://empty", randomUUID() as FamilyId);

    expect(await trigger("purge", empty)).toEqual({ status: 200, body: { purged: 0, deleted: 0 } });
    expect(await on(empty, (application) => Promise.resolve(application.familyId))).toBe(empty.familyId);
    expect(await trigger("purge", { ...empty, familyId: randomUUID() as FamilyId })).toEqual({ status: 403, body: { error: "family-id-differs" } });
  });

  it("records a Source Type installed since, when it opens a database this release already prepared", async () => {
    const database = databases.get(a.databaseUrl)!;
    await database.query("delete from source_type");

    expect((await trigger("purge", a)).status).toBe(200);

    expect(await database.query("select id, enabled from source_type")).toEqual([{ id: "ics", enabled: false }]);
  });

  it("refuses a database of the data model before the rebuild for any operation, writing nothing to it", async () => {
    const other = await PGlite.create();
    empties.set("postgres://other", other);
    await other.exec("create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint); insert into drizzle.__drizzle_migrations (hash) values ('of the old data model')");
    const context = contextOf("postgres://other", randomUUID() as FamilyId);

    for (const name of ["due-work", "purge", "secret-sweep"]) {
      expect(await trigger(name, context)).toEqual({ status: 409, body: { error: "old-data-model" } });
    }
    expect((await other.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'")).rows).toEqual([{ n: 0 }]);
    expect(warnings.join("\n")).toContain("old-data-model");
  });

  it("refuses a database a newer release migrated for any operation, writing nothing to it", async () => {
    const newer = await PGlite.create();
    empties.set("postgres://newer", newer);
    const context = contextOf("postgres://newer", randomUUID() as FamilyId);
    expect((await trigger("purge", context)).status).toBe(200);
    await families.close();
    await newer.exec("insert into drizzle.__drizzle_migrations (hash, created_at) values ('of a newer release', 0)");

    for (const name of ["due-work", "purge", "secret-sweep"]) {
      expect(await trigger(name, context)).toEqual({ status: 409, body: { error: "migrated-by-newer-release" } });
    }
  });

  it("answers 503 for an operation while preparing outlasts its wait, and runs it once preparing is done", async () => {
    families = new SuppliedFamilies({ shared, connectDatabase, serving: () => () => new Response("page"), preparingWaitMs: 100 });
    app = createSuppliedTriggerApp({ token, contextKey, families, log: { warn: (line) => void warnings.push(line), error: () => {} } });
    empties.set("postgres://empty", await PGlite.create());
    const empty = contextOf("postgres://empty", randomUUID() as FamilyId);
    const release = held("postgres://empty");

    expect(await trigger("purge", empty)).toEqual({ status: 503, body: { error: "migrating" } });
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await trigger("purge", empty)).toEqual({ status: 200, body: { purged: 0, deleted: 0 } });
  });

  it.each<[string, () => Context | string | null, number]>([
    ["without a Context", () => null, 401],
    ["with an altered one", () => `${sealContext(contextKey, a)}x`, 401],
    ["with one sealed under another key", () => sealContext("another-context-key-of-32-characters!", a), 401],
    ["with an expired one", () => ({ ...a, expiresAt: Date.now() - 60_000 }), 401],
    ["with settings the core does not take", () => ({ ...a, timeZone: "Mars/Olympus" }), 400],
  ])("refuses a trigger %s, opening nothing", async (_, context, status) => {
    opened = [];

    for (const name of ["due-work", "purge", "secret-sweep"]) {
      expect((await trigger(name, context())).status).toBe(status);
    }
    expect(opened).toEqual([]);
  });

  it("asks for the token before it looks at the Context", async () => {
    opened = [];

    expect((await trigger("purge", a, undefined, {})).status).toBe(401);
    expect((await trigger("purge", a, undefined, { authorization: "Bearer wrong" })).status).toBe(401);
    expect(opened).toEqual([]);
  });

  it("answers 503 for a database that cannot be reached", async () => {
    expect(await trigger("purge", { ...a, databaseUrl: "postgres://gone" })).toEqual({ status: 503, body: { error: "unavailable" } });
  });

  const held = (databaseUrl: string) => {
    let release = () => {};
    migrationsHeld.set(databaseUrl, new Promise<void>((resolve) => (release = resolve)));
    return release;
  };
  const settled = async (promise: Promise<unknown>) => {
    let done = false;
    void promise.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return done;
  };

  it("lets a trigger for a Family wait while another prepares it, then runs it on the prepared database", async () => {
    empties.set("postgres://empty", await PGlite.create());
    const empty = contextOf("postgres://empty", randomUUID() as FamilyId);
    const release = held("postgres://empty");

    const first = trigger("purge", empty);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = trigger("purge", { ...empty, publicUrl: "http://elsewhere" });

    expect(await settled(second)).toBe(false);
    release();
    expect((await Promise.all([first, second])).map(({ status }) => status)).toEqual([200, 200]);
  });

  it("serves one Family while another is being prepared", async () => {
    empties.set("postgres://empty", await PGlite.create());
    const empty = contextOf("postgres://empty", randomUUID() as FamilyId);
    const release = held("postgres://empty");

    const preparing = trigger("purge", empty);
    expect(await trigger("purge", a)).toEqual({ status: 200, body: { purged: 0, deleted: 0 } });
    expect(await settled(preparing)).toBe(false);
    release();
    expect((await preparing).status).toBe(200);
  });

  it("lets due work triggered for a Family during a run wait for that run, whatever else its Context says", async () => {
    const ofA = await addSource(a, "https://a.example.org/a.ics");
    clock.advance(60 * 60_000);

    const answers = await Promise.all([trigger("due-work", a), trigger("due-work", { ...a, publicUrl: "http://elsewhere" })]);

    for (const { body } of answers) expect(body).toMatchObject({ polled: { ok: true, report: { ran: [ofA] } } });
  });
});
