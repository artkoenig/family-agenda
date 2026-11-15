import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrateFamily, migrationsFolder, postgresSchema, type FamilyId, type PostgresConnection } from "@family-agenda/adapters";
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
  let opened: string[];
  let warnings: string[];
  let families: SuppliedFamilies;
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
      return { db, migrate: (options = {}) => migrateFamily(db, migrationsFolder, options.familyId), close: () => Promise.resolve() };
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
    opened = [];
    warnings = [];
    const shared = await bootShared({
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
    // Records the Source Type the plugin brings, as preparing does.
    for (const context of [a, b]) expect((await trigger("prepare-family", context)).status).toBe(200);
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

  it("enters an Admin, resets a password, purges and sweeps in the Context's Family only", async () => {
    expect(await trigger("enter-admin", a, { email: "anna@example.org" })).toEqual({ status: 200, body: { email: "anna@example.org", outcome: "first" } });
    expect((await trigger("reset-admin-password", a, { email: "anna@example.org" })).status).toBe(200);
    expect(await trigger("reset-admin-password", b, { email: "anna@example.org" })).toEqual({ status: 404, body: { error: "unknown-admin" } });
    expect(await trigger("enter-admin", b, { email: "anna@example.org" })).toEqual({ status: 200, body: { email: "anna@example.org", outcome: "first" } });
    expect(await trigger("purge", a)).toEqual({ status: 200, body: { purged: 0, deleted: 0 } });
    expect(await trigger("secret-sweep", b)).toEqual({ status: 200, body: { removed: 0 } });
    expect(await databases.get(a.databaseUrl)?.query("select email from admin")).toEqual([{ email: "anna@example.org" }]);
  });

  it("prepares an empty database with the Context's Family id, and refuses another id after", async () => {
    empties.set("postgres://empty", await PGlite.create());
    const empty = contextOf("postgres://empty", randomUUID() as FamilyId);

    expect(await trigger("enter-admin", empty, { email: "anna@example.org" })).toEqual({ status: 409, body: { error: "family-not-prepared" } });
    expect(await trigger("prepare-family", empty)).toEqual({ status: 200, body: { familyId: empty.familyId } });
    expect(await trigger("enter-admin", empty, { email: "anna@example.org" })).toEqual({ status: 200, body: { email: "anna@example.org", outcome: "first" } });
    expect(await on(empty, (application) => Promise.resolve(application.familyId))).toBe(empty.familyId);
    // Again, once the Family is open: it changes nothing, and the next request opens it anew.
    expect(await trigger("prepare-family", empty)).toEqual({ status: 200, body: { familyId: empty.familyId } });
    expect(await trigger("enter-admin", empty, { email: "anna@example.org" })).toEqual({ status: 200, body: { email: "anna@example.org", outcome: "exists" } });

    const another = { ...empty, familyId: randomUUID() as FamilyId };
    expect(await trigger("prepare-family", another)).toEqual({ status: 409, body: { error: "family-id-differs", familyId: empty.familyId } });
    expect(await trigger("purge", another)).toEqual({ status: 403, body: { error: "family-id-differs" } });
  });

  it("refuses a body naming a Family id other than the Context's, changing nothing", async () => {
    empties.set("postgres://empty", await PGlite.create());
    const empty = contextOf("postgres://empty", randomUUID() as FamilyId);

    expect(await trigger("prepare-family", empty, { familyId: randomUUID() })).toEqual({ status: 400, body: { error: "family-id-not-the-contexts" } });
    expect(await trigger("prepare-family", empty, { familyId: "nope" })).toEqual({ status: 400, body: { error: "invalid-family-id" } });
    expect(await trigger("prepare-family", empty, { familyId: empty.familyId })).toEqual({ status: 200, body: { familyId: empty.familyId } });
  });

  it("refuses a database prepared by another release, writing nothing to it", async () => {
    const other = await PGlite.create();
    empties.set("postgres://other", other);
    await other.exec("create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint); insert into drizzle.__drizzle_migrations (hash) values ('of another release')");
    const context = contextOf("postgres://other", randomUUID() as FamilyId);

    for (const name of ["due-work", "purge", "secret-sweep", "enter-admin", "reset-admin-password"]) {
      expect(await trigger(name, context, { email: "anna@example.org" })).toEqual({ status: 409, body: { error: "family-not-prepared" } });
    }
    expect((await other.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'")).rows).toEqual([{ n: 0 }]);
    expect(warnings.join("\n")).toContain("family-not-prepared");
  });

  it.each<[string, () => Context | string | null, number]>([
    ["without a Context", () => null, 401],
    ["with an altered one", () => `${sealContext(contextKey, a)}x`, 401],
    ["with one sealed under another key", () => sealContext("another-context-key-of-32-characters!", a), 401],
    ["with an expired one", () => ({ ...a, expiresAt: Date.now() - 60_000 }), 401],
    ["with settings the core does not take", () => ({ ...a, timeZone: "Mars/Olympus" }), 400],
  ])("refuses a trigger %s, opening nothing", async (_, context, status) => {
    opened = [];

    for (const name of ["due-work", "purge", "secret-sweep", "prepare-family", "enter-admin", "reset-admin-password"]) {
      expect((await trigger(name, context(), { email: "anna@example.org" })).status).toBe(status);
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
});
