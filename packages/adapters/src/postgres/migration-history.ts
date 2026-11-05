import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql, type SQL } from "drizzle-orm";

/** What the check needs of a database, whichever driver reaches it. */
type Queryable = { execute(query: SQL): PromiseLike<unknown> };

/** A database whose migration history is not the one this version starts from (ADR-0016). */
export class OldMigrationHistoryError extends Error {
  constructor() {
    super(
      "This database was created by a version of Family Agenda before the data model was rebuilt (ADR-0016), " +
        "and cannot be upgraded: there is no data migration. Start over: stop the Instance, " +
        "remove its data volumes as the release notes (RELEASE_NOTES.md) list them, then start it again and set it up as new. " +
        "Keep the master key if you want to enter the Source credentials from your Recovery Kit again.",
    );
    this.name = "OldMigrationHistoryError";
  }
}

/**
 * Refuses a database that carries the migration history of the old data model. Migrations are
 * checked by their hash, and every version since the rebuild starts with the same initial
 * migration, so a database whose first migration is another one is an old Instance. Without this,
 * the migrator would find its history "newer" than the one migration and skip it silently, or run
 * on a half-applied schema. A database that never ran a migration is fine.
 */
export async function refuseOldMigrationHistory(db: Queryable, migrationsFolder: string): Promise<void> {
  const first = await firstAppliedMigration(db);
  if (first === null) return;
  const [initial] = readMigrationFiles({ migrationsFolder });
  if (first !== initial?.hash) throw new OldMigrationHistoryError();
}

async function firstAppliedMigration(db: Queryable): Promise<string | null> {
  const { rows } = (await db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`)) as {
    rows: { present: boolean }[];
  };
  if (!rows[0]?.present) return null;
  const applied = (await db.execute(sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 1`)) as {
    rows: { hash: string }[];
  };
  return applied.rows[0]?.hash ?? null;
}
