import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migrationsFolder } from "@family-agenda/adapters";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** A data directory of in-process Postgres with every migration run, as `dumpDataDir` makes it. */
    postgresSnapshot: string;
    /** Empties every table and puts back the rows the migrations insert, such as `settings`. */
    postgresReset: string;
  }
}

/**
 * Runs the migrations once for the whole test run, in an in-process Postgres (PGlite), and keeps
 * its data directory, which every test database starts from. Starting PGlite from nothing takes
 * seconds; loading a data directory, a fraction of one.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), "family-agenda-postgres-"));
  const postgres = await PGlite.create();
  try {
    await migrate(drizzle(postgres), { migrationsFolder });
    project.provide("postgresReset", await resetScript(postgres));
    const snapshot = join(directory, "snapshot.tar");
    await writeFile(snapshot, Buffer.from(await (await postgres.dumpDataDir("none")).arrayBuffer()));
    project.provide("postgresSnapshot", snapshot);
  } finally {
    await postgres.close();
  }
  return () => rm(directory, { recursive: true, force: true });
}

async function resetScript(postgres: PGlite): Promise<string> {
  const { rows: tables } = await postgres.query<{ name: string }>(
    "SELECT quote_ident(tablename) AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const statements = [`TRUNCATE ${tables.map((table) => table.name).join(", ")} RESTART IDENTITY CASCADE`];
  for (const { name } of tables) {
    const { rows } = await postgres.query<{ seeded: string | null }>(`SELECT json_agg(t)::text AS seeded FROM ${name} t`);
    const seeded = rows[0]?.seeded;
    if (!seeded) continue;
    statements.push(
      `INSERT INTO ${name} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::${name}, ${quote(seeded)})`,
    );
  }
  return statements.join(";\n");
}

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
