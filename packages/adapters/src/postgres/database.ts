import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import { migrateFamily, type FamilyId } from "./family-id";
import { retriedOnLockTimeout } from "./lock-timeout";
import { refuseNewerMigrationHistory, refuseOldMigrationHistory } from "./migration-history";
import * as schema from "./schema";

/** The schema in Postgres, through whichever driver reaches it. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export type MigrateOptions = { familyId?: FamilyId };

export type PostgresConnection = {
  db: Database;
  /**
   * Brings the schema up to date, one connection at a time, and writes a given Family id while the
   * database has none (`migrateFamily`); a different one already there is refused.
   */
  migrate(options?: MigrateOptions): Promise<void>;
  close(): Promise<void>;
};

/** The SQL migrations drizzle-kit generates from `schema.ts`. */
export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export { schema as postgresSchema };

/** Arbitrary key that serialises migrations run by `api` and `worker` starting together. */
const migrationLockKey = 7_342_001;

/**
 * How long a migration waits for a table another connection holds, such as a long transaction of
 * a core serving the Family, before it gives up and is tried again: it never queues every other
 * request on that table behind it for long.
 */
const migrationLockTimeoutMs = 5_000;

export function connectPostgres(databaseUrl: string): PostgresConnection {
  // Idle connections close after ten seconds, also for a Family a core in supplied mode opened (ADR-0003).
  const pool = new pg.Pool({ connectionString: databaseUrl, idleTimeoutMillis: 10_000 });
  const db = drizzle(pool, { schema });
  return {
    db,
    async migrate(options = {}) {
      const lockClient = await pool.connect();
      try {
        await lockClient.query("SELECT pg_advisory_lock($1)", [migrationLockKey]);
        await refuseOldMigrationHistory(db, migrationsFolder);
        await refuseNewerMigrationHistory(db, migrationsFolder);
        await retriedOnLockTimeout(() => migrateFamily(db, migrationsFolder, options.familyId, { lockTimeoutMs: migrationLockTimeoutMs }));
      } finally {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [migrationLockKey]);
        lockClient.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function runMigrations(connection: PostgresConnection, options: MigrateOptions = {}): Promise<void> {
  await connection.migrate(options);
}
