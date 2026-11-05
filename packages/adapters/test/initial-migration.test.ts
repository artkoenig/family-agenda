import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { migrationsFolder, OldMigrationHistoryError, refuseOldMigrationHistory } from "../src";

const targetSchema = fileURLToPath(new URL("../../../docs/schema.sql", import.meta.url));

const open: PGlite[] = [];
const emptyDatabase = async () => {
  const postgres = await PGlite.create();
  open.push(postgres);
  return postgres;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((postgres) => postgres.close()));
});

/**
 * Everything the schema consists of, as text, without what Postgres or the tool names itself: the
 * names of primary and foreign keys and of NOT NULL constraints, and the comments in a function.
 */
async function describeSchema(postgres: PGlite): Promise<string[]> {
  const rows = async (query: string) => (await postgres.query<{ line: string }>(query)).rows.map((row) => row.line);
  const functions = (await postgres.query<{ name: string; body: string }>(`SELECT proname AS name, pg_get_functiondef(oid) AS body FROM pg_proc WHERE pronamespace = 'public'::regnamespace`)).rows;
  return [
    ...(await rows(`SELECT concat_ws(' | ', 'column', table_name, column_name, data_type, is_nullable, column_default, is_identity) AS line FROM information_schema.columns WHERE table_schema = 'public'`)),
    ...(await rows(`SELECT concat_ws(' | ', 'constraint', conrelid::regclass, CASE WHEN contype IN ('p', 'f') THEN contype::text ELSE conname END, pg_get_constraintdef(oid)) AS line FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype <> 'n'`)),
    ...(await rows(`SELECT concat_ws(' | ', 'index', tablename, indexdef) AS line FROM pg_indexes WHERE schemaname = 'public' AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE contype = 'p')`)),
    ...(await rows(`SELECT concat_ws(' | ', 'trigger', tgrelid::regclass, tgname, pg_get_triggerdef(oid)) AS line FROM pg_trigger WHERE NOT tgisinternal`)),
    ...functions.map(({ name, body }) => `function | ${name} | ${body.replaceAll(/--.*$/gm, "").replaceAll(/\s+/g, " ")}`),
    ...(await rows(`SELECT concat_ws(' | ', 'family', language, ocr_enabled, ocr_languages) AS line FROM family`)),
  ].sort();
}

describe("the initial migration", () => {
  it("starts the history, and applying the migrations to an empty database yields the target schema", async () => {
    const migrations = (await readdir(migrationsFolder)).filter((file) => file.endsWith(".sql")).sort();
    expect(migrations[0]).toBe("0000_initial.sql");
    const migrated = await emptyDatabase();
    await migrate(drizzle(migrated), { migrationsFolder });
    const target = await emptyDatabase();
    await target.exec(await readFile(targetSchema, "utf8"));

    expect(await describeSchema(migrated)).toEqual(await describeSchema(target));
  });
});

describe("a database that carries the old migration history", () => {
  const databaseOf = (postgres: PGlite) => drizzle(postgres);

  it("is refused with a message that tells the Admin to start over", async () => {
    const old = await emptyDatabase();
    await old.exec(`
      CREATE SCHEMA drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at BIGINT);
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('hash-of-the-old-initial-migration', 1), ('hash-of-the-old-tasks-migration', 2);
      CREATE TABLE settings (id BOOLEAN PRIMARY KEY);`);

    const refused = refuseOldMigrationHistory(databaseOf(old), migrationsFolder);

    await expect(refused).rejects.toThrow(OldMigrationHistoryError);
    await expect(refused).rejects.toThrow(/start over/i);
    await expect(refused).rejects.toThrow(/master key/);
  });

  it("is not mistaken for an Instance that is up to date, or one that has not been migrated yet", async () => {
    const fresh = await emptyDatabase();
    await expect(refuseOldMigrationHistory(databaseOf(fresh), migrationsFolder)).resolves.toBeUndefined();

    await migrate(drizzle(fresh), { migrationsFolder });
    await expect(refuseOldMigrationHistory(databaseOf(fresh), migrationsFolder)).resolves.toBeUndefined();
  });
});
