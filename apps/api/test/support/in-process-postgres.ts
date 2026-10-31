import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { migrationsFolder, postgresSchema, type PostgresConnection } from "@family-agenda/adapters";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { inject } from "vitest";

/** A database of its own for one test Instance, in-process: no Postgres server needed. */
export type InProcessPostgres = {
  /** Connects the Application to it; closing that connection leaves the database as it is. */
  connect(): PostgresConnection;
  query(sql: string): Promise<Record<string, unknown>[]>;
  /** Hands the database back, emptied, for the next test of the file. */
  release(): Promise<void>;
};

let snapshot: Promise<Blob> | undefined;
/** Databases a closed test Instance handed back, already emptied. */
const idle: PGlite[] = [];

/** Takes an emptied database, or loads a new one from the migrated snapshot. */
export async function acquirePostgres(): Promise<InProcessPostgres> {
  const postgres = idle.pop() ?? (await load());
  return {
    connect() {
      const db = drizzle(postgres, { schema: postgresSchema });
      return {
        db,
        migrate: () => migrate(db, { migrationsFolder }),
        close: () => Promise.resolve(),
      };
    },
    async query(sql) {
      return (await postgres.query<Record<string, unknown>>(sql)).rows;
    },
    async release() {
      await postgres.exec(inject("postgresReset"));
      idle.push(postgres);
    },
  };
}

async function load(): Promise<PGlite> {
  snapshot ??= readFile(inject("postgresSnapshot")).then((bytes) => new Blob([bytes]));
  return PGlite.create({ loadDataDir: await snapshot });
}
