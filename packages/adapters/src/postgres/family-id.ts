import { sql, type SQL } from "drizzle-orm";
import { readMigrationFiles, type MigrationConfig, type MigrationMeta } from "drizzle-orm/migrator";

/** What preparing the Family needs of a database, whichever driver reaches it. */
type Queryable = { execute(query: SQL): PromiseLike<unknown> };

/** What drizzle's own `migrate` hands the migrations to, on every driver. */
type Migrator = { dialect: { migrate(migrations: MigrationMeta[], session: unknown, config: MigrationConfig): Promise<void> }; session: unknown };

/** A Family id: a UUID, lower-cased, as `parseFamilyId` reads it. */
export type FamilyId = string & { readonly familyId: unique symbol };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Family id `value` names, lower-cased; null for anything that is no UUID. */
export function parseFamilyId(value: unknown): FamilyId | null {
  if (typeof value !== "string") return null;
  const id = value.toLowerCase();
  return uuidPattern.test(id) ? (id as FamilyId) : null;
}

/** A Family id given for a database that already holds another one. */
export class FamilyIdConflictError extends Error {
  constructor(
    readonly stored: string,
    readonly given: string,
  ) {
    super(`This database holds the Family ${stored}, not ${given}; nothing was changed.`);
    this.name = "FamilyIdConflictError";
  }
}

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

/**
 * The Family id the database holds, or null while it has none: an empty database, or one
 * migrated before Family ids (`0008_family_public_id` named it `public_id`, `0009` renamed it).
 */
export async function storedFamilyId(db: Queryable): Promise<string | null> {
  const columns = rowsOf<{ name: string }>(
    await db.execute(sql`SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'family' AND column_name IN ('family_id', 'public_id')`),
  );
  const column = columns[0]?.name;
  if (column === undefined) return null;
  const [row] = rowsOf<{ id: string }>(await db.execute(sql`SELECT ${sql.identifier(column)}::text AS id FROM family`));
  return row?.id ?? null;
}

/**
 * Brings the schema up to date for the Family `familyId` names, as drizzle's `migrate` does. A
 * given id is written while the database has none, by the last migration, in the one transaction
 * all of them run in, so a failed write leaves no random id behind; one that differs from the id
 * it holds is refused before anything changes. Without one, the Family keeps its id, or gets the
 * random UUID the schema draws.
 */
export async function migrateFamily(db: Queryable, migrationsFolder: string, familyId?: FamilyId): Promise<void> {
  const stored = familyId === undefined ? null : await storedFamilyId(db);
  if (familyId !== undefined && stored !== null && stored !== familyId) throw new FamilyIdConflictError(stored, familyId);
  const migrations = readMigrationFiles({ migrationsFolder });
  const last = migrations.at(-1);
  // The id is a UUID, so it is safe inline; the migrator runs statements as they are.
  if (familyId !== undefined && stored === null && last) last.sql.push(`UPDATE family SET family_id = '${familyId}'`);
  const migrator = db as unknown as Migrator;
  await migrator.dialect.migrate(migrations, migrator.session, { migrationsFolder });
}
