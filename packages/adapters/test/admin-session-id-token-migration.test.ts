import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { migratedBefore } from "./migrated-before";

describe("the migration keeping the ID token with an Admin session", () => {
  it("keeps the sessions there were, without an ID token, and lets an older core start sessions as before", async () => {
    const { postgres, folder } = await migratedBefore("0016_admin_session_id_token");
    await postgres.exec(`INSERT INTO admin_session (id, subject, email, expires_at) VALUES ('s1', 'sub-anna', 'anna@example.org', now() + interval '1 day')`);

    await migrate(drizzle(postgres), { migrationsFolder: folder });
    await postgres.exec(`INSERT INTO admin_session (id, subject, email, expires_at) VALUES ('s2', 'sub-ben', 'ben@example.org', now() + interval '1 day')`);

    expect((await postgres.query("SELECT id, id_token FROM admin_session ORDER BY id")).rows).toEqual([
      { id: "s1", id_token: null },
      { id: "s2", id_token: null },
    ]);
  });
});
