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
        "remove its data volumes as docs/upgrading.md lists them, then start it again and set it up as new. " +
        "Keep the master key if you want to enter the Source credentials from your Recovery Kit again.",
    );
    this.name = "OldMigrationHistoryError";
  }
}

/** A database that a newer version has migrated further than this version knows. */
export class NewerMigrationHistoryError extends Error {
  constructor(applied: number, known: number) {
    super(
      `This database was migrated by a newer version of Family Agenda: it has ${applied} migrations, this version knows ${known}. ` +
        "Running an older version on it could damage it, so this version does not start. " +
        "Start the newer version again, or restore a backup taken before you switched to it. " +
        "docs/upgrading.md explains how to back up, switch versions and restore.",
    );
    this.name = "NewerMigrationHistoryError";
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
  const [first] = await appliedMigrations(db);
  if (first === undefined) return;
  const [initial] = readMigrationFiles({ migrationsFolder });
  if (first !== initial?.hash) throw new OldMigrationHistoryError();
}

/**
 * Refuses a database that has more migrations applied than this version has: a newer version
 * migrated it, for example before the Instance was switched from `main` back to a release. The
 * migrator would skip the history it does not know without a word, and the older code would run
 * on a schema it was not written for.
 */
export async function refuseNewerMigrationHistory(db: Queryable, migrationsFolder: string): Promise<void> {
  const applied = (await appliedMigrations(db)).length;
  const known = readMigrationFiles({ migrationsFolder }).length;
  if (applied > known) throw new NewerMigrationHistoryError(applied, known);
}

/** The hashes of the migrations a database has applied, oldest first; none if it never migrated. */
async function appliedMigrations(db: Queryable): Promise<string[]> {
  const { rows } = (await db.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`)) as {
    rows: { present: boolean }[];
  };
  if (!rows[0]?.present) return [];
  const applied = (await db.execute(sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id`)) as {
    rows: { hash: string }[];
  };
  return applied.rows.map((row) => row.hash);
}
