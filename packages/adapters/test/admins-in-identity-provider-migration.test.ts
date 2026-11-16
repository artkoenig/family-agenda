import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";
import { migratedBefore } from "./migrated-before";

describe("the migration to Admins only in the Identity Provider", () => {
  it("drops the Admin table, the failed sign-ins and the sessions' Admin, ending the sessions there were", async () => {
    const { postgres, folder } = await migratedBefore("0012_admins_in_identity_provider");
    await postgres.exec(`
      INSERT INTO admin (id, email, password_hash) VALUES ('00000000-0000-4000-8000-000000000001', 'anna@example.org', 'hash');
      INSERT INTO admin_session (id, admin_id, expires_at) VALUES ('s1', '00000000-0000-4000-8000-000000000001', now() + interval '1 day');
      INSERT INTO sign_in_failure (key, at) VALUES ('client:1', now());
    `);

    await migrate(drizzle(postgres), { migrationsFolder: folder });

    const tables = await postgres.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_name IN ('admin', 'sign_in_failure')");
    expect(tables.rows).toEqual([]);
    const columns = await postgres.query<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'admin_session' ORDER BY column_name");
    expect(columns.rows.map((row) => row.name)).toEqual(["email", "expires_at", "id", "subject"]);
    expect((await postgres.query("SELECT * FROM admin_session")).rows).toEqual([]);
  });
});
