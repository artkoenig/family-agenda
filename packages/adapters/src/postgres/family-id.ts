import { sql, type SQL } from "drizzle-orm";

/** What preparing the Family needs of a database, whichever driver reaches it. */
type Queryable = { execute(query: SQL): PromiseLike<unknown> };

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
 * Brings the schema up to date with `migrate` for the Family `familyId` names. A given id is
 * written while the database has none; one that differs from the id it holds is refused before
 * anything changes. Without one, the Family keeps its id, or gets the random UUID the schema draws.
 */
export async function migrateFamily(db: Queryable, migrate: () => Promise<void>, familyId?: string): Promise<void> {
  const stored = familyId === undefined ? null : await storedFamilyId(db);
  if (familyId !== undefined && stored !== null && stored !== familyId) throw new FamilyIdConflictError(stored, familyId);
  await migrate();
  if (familyId !== undefined && stored === null) await db.execute(sql`UPDATE family SET family_id = ${familyId}`);
}
