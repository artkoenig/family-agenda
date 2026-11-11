import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { migrationsFolder } from "../src";

const open: { postgres: PGlite; folder: string }[] = [];
afterEach(async () => {
  for (const { postgres, folder } of open.splice(0)) {
    await postgres.close();
    await rm(folder, { recursive: true, force: true });
  }
});

/** A database migrated up to, not including, the migration with the given tag, and the folder of all migrations. */
async function migratedBefore(tag: string) {
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

describe("the migration to Task descriptions", () => {
  it("turns the things to bring into a description with a line per thing, in the row and in what the Source stated", async () => {
    const { postgres, folder } = await migratedBefore("0007_task_description");
    await postgres.exec(`
      INSERT INTO source_type (id) VALUES ('school');
      INSERT INTO source (source_type_id, config_version) VALUES ('school', 1);
      INSERT INTO source_record (source_id, external_id, stated)
        SELECT id, 'kit', '{"kind": "task", "title": "Bring sports kit", "deadline": null, "bring": ["Trainers", "Towel"]}' FROM source;
      INSERT INTO source_record (source_id, external_id, stated)
        SELECT id, 'form', '{"kind": "task", "title": "Sign the form", "deadline": null, "bring": []}' FROM source;
      INSERT INTO source_record (source_id, external_id, stated)
        SELECT id, 'trip', '{"kind": "event", "title": "Trip", "place": null}' FROM source;
      INSERT INTO item (kind, record_id) SELECT 'task', id FROM source_record WHERE external_id IN ('kit', 'form');
      INSERT INTO task (item_id, title, bring)
        SELECT item.id, record.stated->>'title', ARRAY(SELECT jsonb_array_elements_text(record.stated->'bring'))
        FROM item JOIN source_record record ON record.id = item.record_id;
    `);

    await migrate(drizzle(postgres), { migrationsFolder: folder });

    const tasks = await postgres.query<{ title: string; description: string | null }>("SELECT title, description FROM task ORDER BY title");
    expect(tasks.rows).toEqual([
      { title: "Bring sports kit", description: "- Trainers\n- Towel" },
      { title: "Sign the form", description: null },
    ]);
    const stated = await postgres.query<{ external_id: string; stated: unknown }>("SELECT external_id, stated FROM source_record ORDER BY external_id");
    expect(stated.rows).toEqual([
      { external_id: "form", stated: { kind: "task", title: "Sign the form", deadline: null, description: null } },
      { external_id: "kit", stated: { kind: "task", title: "Bring sports kit", deadline: null, description: "- Trainers\n- Towel" } },
      { external_id: "trip", stated: { kind: "event", title: "Trip", place: null } },
    ]);
  });
});
