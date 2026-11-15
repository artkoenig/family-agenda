import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrateFamily, migrationsFolder, postgresSchema, type FamilyId, type PostgresConnection } from "@family-agenda/adapters";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootApplication, bootShared, prepareFamily, type SharedWiring } from "../../src/composition-root";
import { createTriggerApp, type TriggeredWork } from "../../src/triggered-operations";
import { bootForTest, type TestInstance } from "../support/boot";

const token = "s3cret-token";
const log = { warn: () => {}, error: () => {} };
const chosen = "0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e" as FamilyId;
const other = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" as FamilyId;

const triggerPrepare = async (work: TriggeredWork, body?: unknown) => {
  const response = await createTriggerApp(work, { token, log }).request("/operations/prepare-family", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("Preparing a Family on an empty database", () => {
  let postgres: PGlite;
  let directory: string;
  beforeEach(async () => {
    postgres = await PGlite.create();
    directory = await mkdtemp(join(tmpdir(), "family-agenda-prepare-"));
  });
  afterEach(async () => {
    await postgres.close();
    await rm(directory, { recursive: true, force: true });
  });

  const connect = (): PostgresConnection => {
    const db = drizzle(postgres, { schema: postgresSchema });
    return {
      db,
      migrate: (options = {}) => migrateFamily(db, migrationsFolder, options.familyId),
      close: () => Promise.resolve(),
    };
  };
  const shared = () => ({ tessdataDirectory: join(directory, "tessdata"), bundledTessdataDirectory: null });
  const boot = (familyId?: FamilyId) =>
    bootApplication({
      ...shared(),
      connectDatabase: connect,
      ...(familyId === undefined ? {} : { familyId }),
      masterKeyFile: join(directory, "master.key"),
      blobDirectory: join(directory, "blobs"),
      timeZone: "Europe/Berlin",
    });
  const notBooted = (wiring: SharedWiring): TriggeredWork => ({
    dueWork: { run: () => Promise.reject(new Error("not booted")) },
    retention: { purge: () => Promise.reject(new Error("not booted")) },
    secretSweep: { sweep: () => Promise.reject(new Error("not booted")) },
    prepare: (familyId) => prepareFamily(wiring, { connectDatabase: connect }, familyId),
    admins: {
      enterAdmin: () => Promise.reject(new Error("not booted")),
      issueNewPassword: () => Promise.reject(new Error("not booted")),
    },
  });

  it("prepares the database before any Family is booted on it, with the Family id chosen", async () => {
    const wiring = await bootShared(shared());

    expect(await prepareFamily(wiring, { connectDatabase: connect }, chosen)).toEqual({ familyId: chosen });
    expect((await postgres.query("SELECT family_id::text AS id FROM family")).rows).toEqual([{ id: chosen }]);
    expect((await boot()).familyId).toBe(chosen);
  });

  it("prepares it through the Triggered operation, and refuses another id after", async () => {
    const work = notBooted(await bootShared(shared()));

    expect(await triggerPrepare(work, { familyId: chosen })).toEqual({ status: 200, body: { familyId: chosen } });
    expect(await triggerPrepare(work, { familyId: other })).toEqual({ status: 409, body: { error: "family-id-differs", familyId: chosen } });
  });

  it("brings the schema up to date with the Family id chosen, and leaves the Family usable", async () => {
    const app = await boot(chosen);

    expect(app.familyId).toBe(chosen);
    expect(await app.admins.needsFirstAdmin()).toBe(true);
    expect((await postgres.query("SELECT family_id::text AS id FROM family")).rows).toEqual([{ id: chosen }]);
  });

  it("draws a random UUID without one, which the next start keeps", async () => {
    const first = await boot();
    const second = await boot();

    expect(first.familyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second.familyId).toBe(first.familyId);
  });

  it("refuses a start with a Family id other than the one the database holds", async () => {
    await boot(chosen);

    await expect(boot(other)).rejects.toThrow(`This database holds the Family ${chosen}, not ${other}`);
  });
});

describe("Preparing the Family as a Triggered operation", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
    await instance.installPlugin({ sourceTypeId: "mailbox" });
    await instance.restart();
  });
  afterEach(async () => {
    await instance.close();
  });

  const state = () => instance.query("SELECT f.family_id::text AS family, s.id, s.enabled FROM family f LEFT JOIN source_type s ON true ORDER BY s.id");

  it("records the Source Types seen for the first time as disabled, and answers with the Family id", async () => {
    await instance.query("DELETE FROM source_type");

    const { status, body } = await triggerPrepare(instance.triggeredWork());

    expect(status).toBe(200);
    expect(body).toEqual({ familyId: instance.app.familyId });
    expect(await state()).toEqual([{ family: instance.app.familyId, id: "mailbox", enabled: false }]);
  });

  it("changes nothing when run again, given the Family id the database holds", async () => {
    await instance.app.sourceTypes.enable("mailbox");
    const before = await state();

    expect((await triggerPrepare(instance.triggeredWork())).status).toBe(200);
    expect((await triggerPrepare(instance.triggeredWork(), { familyId: instance.app.familyId })).status).toBe(200);

    expect(await state()).toEqual(before);
  });

  it("refuses another Family id and changes nothing", async () => {
    await instance.query("DELETE FROM source_type");
    const before = await state();

    const { status, body } = await triggerPrepare(instance.triggeredWork(), { familyId: other });

    expect(status).toBe(409);
    expect(body).toEqual({ error: "family-id-differs", familyId: instance.app.familyId });
    expect(await state()).toEqual(before);
  });
});
