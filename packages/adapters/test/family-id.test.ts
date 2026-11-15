import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { FamilyIdConflictError, migrateFamily, migrationsFolder, parseFamilyId, storedFamilyId, type FamilyId } from "../src";
import { migratedBefore } from "./migrated-before";

const open: PGlite[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((postgres) => postgres.close()));
});

const given = "0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e" as FamilyId;
const other = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" as FamilyId;

async function emptyDatabase() {
  const postgres = await PGlite.create();
  open.push(postgres);
  const db = drizzle(postgres);
  return { postgres, db, prepare: (familyId?: FamilyId) => migrateFamily(db, migrationsFolder, familyId) };
}

const familyIds = async (postgres: PGlite) => (await postgres.query<{ id: string }>("SELECT family_id::text AS id FROM family")).rows.map((row) => row.id);

describe("a Family id", () => {
  it("is a UUID, lower-cased", () => {
    expect(parseFamilyId(given.toUpperCase())).toBe(given);
    expect(parseFamilyId(` ${given}`)).toBeNull();
    expect(parseFamilyId(`${given}0`)).toBeNull();
    expect(parseFamilyId("family-1")).toBeNull();
    expect(parseFamilyId(7)).toBeNull();
  });
});

describe("preparing the schema for a Family", () => {
  it("brings an empty database up to date and writes the Family id given", async () => {
    const { postgres, prepare } = await emptyDatabase();

    await prepare(given);

    expect(await familyIds(postgres)).toEqual([given]);
  });

  it("draws a random UUID without one", async () => {
    const { postgres, prepare } = await emptyDatabase();

    await prepare();

    expect(await familyIds(postgres)).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);
  });

  it("changes nothing when run again, with or without the same id", async () => {
    const { postgres, prepare } = await emptyDatabase();
    await prepare(given);

    await prepare(given);
    await prepare();

    expect(await familyIds(postgres)).toEqual([given]);
  });

  it("leaves no random id behind when writing the given one fails, so it can be given again", async () => {
    const { postgres, db, prepare } = await emptyDatabase();

    // An id the column cannot hold, as stand-in for a write that fails.
    const failed = migrateFamily(db, migrationsFolder, "not-a-uuid" as FamilyId);

    await expect(failed).rejects.toThrow();
    expect(await storedFamilyId(db)).toBeNull();
    await prepare(given);
    expect(await familyIds(postgres)).toEqual([given]);
  });

  it("refuses an id that differs from the one the database holds, before migrating", async () => {
    const { postgres, db } = await emptyDatabase();
    await migrateFamily(db, migrationsFolder, given);
    const refused = migrateFamily(db, migrationsFolder, other);

    await expect(refused).rejects.toThrow(FamilyIdConflictError);
    await expect(refused).rejects.toMatchObject({ stored: given, given: other });
    expect(await familyIds(postgres)).toEqual([given]);
  });

  it("knows the id of a database migrated before the column was renamed", async () => {
    const { postgres } = await migratedBefore("0009_family_id");
    const [row] = (await postgres.query<{ id: string }>("SELECT public_id::text AS id FROM family")).rows;

    expect(await storedFamilyId(drizzle(postgres))).toBe(row?.id);
  });

  it("finds no id in a database migrated before Family ids", async () => {
    const { postgres } = await migratedBefore("0008_family_public_id");

    expect(await storedFamilyId(drizzle(postgres))).toBeNull();
  });
});
