import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { migratedBefore } from "./migrated-before";

describe("the migration to the Family id", () => {
  it("keeps the id the Family had before", async () => {
    const { postgres, folder } = await migratedBefore("0009_family_id");
    const before = await postgres.query<{ public_id: string }>("SELECT public_id FROM family");

    await migrate(drizzle(postgres), { migrationsFolder: folder });

    const after = await postgres.query<{ family_id: string }>("SELECT family_id FROM family");
    expect(after.rows).toEqual([{ family_id: before.rows[0]?.public_id }]);
  });

  it("gives a Family set up on an empty database a random UUID", async () => {
    const { postgres, folder } = await migratedBefore("0009_family_id");
    await migrate(drizzle(postgres), { migrationsFolder: folder });
    await postgres.exec("DELETE FROM family; INSERT INTO family DEFAULT VALUES;");

    const rows = await postgres.query<{ family_id: string }>("SELECT family_id FROM family");
    expect(rows.rows[0]?.family_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
