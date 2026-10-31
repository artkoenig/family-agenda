import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema";

/** The schema in Postgres, through whichever driver reaches it. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type PostgresConnection = {
  db: Database;
  /** Brings the schema up to date, one connection at a time. */
  migrate(): Promise<void>;
  close(): Promise<void>;
};

/** The SQL migrations drizzle-kit generates from `schema.ts`. */
export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export { schema as postgresSchema };

/** Arbitrary key that serialises migrations run by `api` and `worker` starting together. */
const migrationLockKey = 7_342_001;

export function connectPostgres(databaseUrl: string): PostgresConnection {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return {
    db,
    async migrate() {
      const lockClient = await pool.connect();
      try {
        await lockClient.query("SELECT pg_advisory_lock($1)", [migrationLockKey]);
        await migrate(db, { migrationsFolder });
      } finally {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [migrationLockKey]);
        lockClient.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function runMigrations(connection: PostgresConnection): Promise<void> {
  await connection.migrate();
}
