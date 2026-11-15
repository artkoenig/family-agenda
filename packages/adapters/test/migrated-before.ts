import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach } from "vitest";
import { migrationsFolder } from "../src";

const open: { postgres: PGlite; folder: string }[] = [];
afterEach(async () => {
  for (const { postgres, folder } of open.splice(0)) {
    await postgres.close();
    await rm(folder, { recursive: true, force: true });
  }
});

/** A database migrated up to, not including, the migration with the given tag, and the folder of all migrations. */
export async function migratedBefore(tag: string) {
  const folder = await mkdtemp(join(tmpdir(), "migrations-"));
  await cp(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  const before = { ...journal, entries: journal.entries.slice(0, journal.entries.findIndex((entry) => entry.tag === tag)) };
  await writeFile(journalPath, JSON.stringify(before));
  const postgres = await PGlite.create();
  open.push({ postgres, folder });
  await migrate(drizzle(postgres), { migrationsFolder: folder });
  await writeFile(journalPath, JSON.stringify(journal));
  return { postgres, folder };
}
