import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

export type PostgresConnection = {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
};

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Arbitrary key that serialises migrations run by `api` and `worker` starting together. */
const migrationLockKey = 7_342_001;

export function connectPostgres(databaseUrl: string): PostgresConnection {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export async function runMigrations(connection: PostgresConnection): Promise<void> {
  const lockClient = await connection.pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [migrationLockKey]);
    await migrate(connection.db, { migrationsFolder });
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [migrationLockKey]);
    lockClient.release();
  }
}
