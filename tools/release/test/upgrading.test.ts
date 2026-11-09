import { describe, expect, it } from "vitest";
import { deriveUpgrading, postgresMajorOf, type Snapshot } from "../src/upgrading";

const docs = "https://github.com/artkoenig/family-agenda/blob/v0.3.0/docs/upgrading.md";
const compose = (postgres: string) => `services:\n  postgres:\n    image: ${postgres}\n    restart: unless-stopped\n`;
const sdk = (version: string) => ({ version });
const snapshot = (migrations: Record<string, string>, postgres = "postgres:17", sdkVersion: string | null = "1.0.0"): Snapshot => ({
  migrations,
  compose: compose(postgres),
  sdk: sdkVersion === null ? null : sdk(sdkVersion),
});

const initial = "CREATE TABLE family (id uuid PRIMARY KEY);";
const released = snapshot({ "0000_initial.sql": initial, "0001_identity_provider.sql": "ALTER TABLE family ADD COLUMN sso boolean;" });

const section = (previous: Snapshot | null, current: Snapshot) => deriveUpgrading(previous, current, docs);

describe("the Upgrading section of a release", () => {
  it("says there is nothing to upgrade from for the first release", () => {
    expect(section(null, released)).toBe("## Upgrading\n\n- This is the first release: there is nothing to upgrade from.\n");
  });

  it("says the data is kept when no migration changed", () => {
    expect(section(released, released)).toBe("## Upgrading\n\n- **Data is kept.**\n");
  });

  it("says the data is kept and migrated on start when migrations were only added", () => {
    const current = snapshot({ ...released.migrations, "0002_tasks.sql": "CREATE TABLE task (id uuid PRIMARY KEY);" });

    expect(section(released, current)).toBe("## Upgrading\n\n- **Data is kept.** The database is migrated when the Instance starts.\n");
  });

  it.each([
    ["DROP COLUMN", "ALTER TABLE family DROP COLUMN sso;"],
    ["DROP TABLE", "drop table task;"],
    ["TRUNCATE", "TRUNCATE TABLE sign_in_failure;"],
    ["DELETE FROM", "DELETE FROM source WHERE kind = 'old';"],
  ])("names an added migration with %s as one that removes data", (_statement, sql) => {
    const current = snapshot({ ...released.migrations, "0002_cleanup.sql": `${sql}\n--> statement-breakpoint\nSELECT 1;` });

    expect(section(released, current)).toBe(
      [
        "## Upgrading",
        "",
        "- **Data is kept.** The database is migrated when the Instance starts.",
        `- This migration removes data: \`0002_cleanup.sql\`. Make a backup first, see [Back up](${docs}#back-up).`,
        "",
      ].join("\n"),
    );
  });

  it("does not take a comment for a statement that removes data", () => {
    const sql = "-- DROP TABLE is not run here\nALTER TABLE family ADD COLUMN note text; -- TRUNCATE nothing";
    const current = snapshot({ ...released.migrations, "0002_note.sql": sql });

    expect(section(released, current)).not.toContain("removes data");
  });

  it("names only the added migrations that remove data, in file order", () => {
    const current = snapshot({
      ...released.migrations,
      "0003_drop_b.sql": "DROP TABLE b;",
      "0002_drop_a.sql": "DROP TABLE a;",
      "0004_add.sql": "CREATE TABLE c (id int);",
    });

    const lines = section(released, current).split("\n").filter((line) => line.includes("removes data"));

    expect(lines.map((line) => /`([^`]+)`/.exec(line)?.[1])).toEqual(["0002_drop_a.sql", "0003_drop_b.sql"]);
  });

  it("requires a start over when an existing migration changed", () => {
    const current = snapshot({ ...released.migrations, "0000_initial.sql": `${initial}\nCREATE TABLE extra (id int);` });

    expect(section(released, current)).toBe(
      `## Upgrading\n\n- **Start over required.** The data model changed in a way that cannot be migrated: \`0000_initial.sql\` changed or was removed. See [Start over](${docs}#start-over).\n`,
    );
  });

  it("requires a start over when migrations were squashed into a new one", () => {
    const current = snapshot({ "0000_initial.sql": "CREATE TABLE everything (id int);" });

    const text = section(released, current);

    expect(text).toContain("**Start over required.**");
    expect(text).toContain("`0000_initial.sql`, `0001_identity_provider.sql` changed or was removed");
  });

  it("names the first three rewritten migrations and counts the rest, so a large squash stays short", () => {
    const many = Object.fromEntries(Array.from({ length: 13 }, (_, number) => [`${String(number).padStart(4, "0")}_step.sql`, `SELECT ${number};`]));

    const text = section(snapshot(many), snapshot({ "0000_initial.sql": "SELECT 0;" }));

    expect(text).toContain("`0000_step.sql`, `0001_step.sql`, `0002_step.sql`, 10 more changed or was removed");
  });

  it("requires a start over, not a data warning, when a rewritten migration comes with new ones", () => {
    const current = snapshot({ "0000_initial.sql": "CREATE TABLE a (id int);", "0001_identity_provider.sql": released.migrations["0001_identity_provider.sql"] ?? "", "0002_drop.sql": "DROP TABLE a;" });

    const text = section(released, current);

    expect(text).toContain("Start over required");
    expect(text).not.toContain("removes data");
  });

  it("asks for a dump and restore when the Postgres major version changed", () => {
    const current = snapshot(released.migrations, "postgres:18");

    expect(section(released, current)).toBe(
      [
        "## Upgrading",
        "",
        "- **Data is kept.**",
        `- **Postgres major upgrade: dump and restore required.** The Postgres version changed from 17 to 18. Back up with the old version running, then see [Restore](${docs}#restore).`,
        "",
      ].join("\n"),
    );
  });

  it("says nothing about Postgres when only its minor version, its tag style or neither side names a major version", () => {
    expect(section(released, snapshot(released.migrations, "postgres:17.5"))).not.toContain("Postgres");
    expect(section(released, snapshot(released.migrations, "postgres:latest"))).not.toContain("Postgres");
    const noCompose = { migrations: released.migrations, compose: "services: {}", sdk: null };
    expect(section(noCompose, noCompose)).not.toContain("Postgres");
  });

  it("lists a Postgres change after a start over", () => {
    const current = snapshot({ "0000_initial.sql": "CREATE TABLE x (id int);" }, "postgres:18");

    const lines = section(released, current).split("\n").filter((line) => line.startsWith("- "));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Start over required");
    expect(lines[1]).toContain("Postgres major upgrade");
  });
});

describe("the SDK in the Upgrading section", () => {
  const withSdk = (from: string | null, to: string | null) => section(snapshot(released.migrations, "postgres:17", from), snapshot(released.migrations, "postgres:17", to));

  it("says nothing when the SDK did not change, or one side has no SDK to compare", () => {
    expect(withSdk("1.0.0", "1.0.0")).toBe("## Upgrading\n\n- **Data is kept.**\n");
    expect(withSdk(null, "1.0.0")).not.toContain("SDK");
    expect(withSdk("1.0.0", null)).not.toContain("SDK");
  });

  it("says that plugins keep working when the SDK got a new minor version", () => {
    expect(withSdk("1.0.0", "1.1.0")).toContain("- **SDK 1.0.0 → 1.1.0.** Source plugins built for SDK 1.0.0 keep working.\n");
  });

  it.each([
    ["1.4.0", "2.0.0"],
    ["0.2.0", "0.3.0"],
    ["1.2.0", "1.1.0"],
  ])("says that plugins built for SDK %s will not load on %s", (from, to) => {
    const text = withSdk(from, to);

    expect(text).toContain(`**Source plugins built for SDK ${from} will not load.** The SDK changed from ${from} to ${to}.`);
    expect(text).toContain("update the ones you added to the `plugins` volume");
  });

  it("lists the SDK after the data and Postgres lines", () => {
    const previous = snapshot(released.migrations, "postgres:17", "1.0.0");
    const current = snapshot({ "0000_initial.sql": "CREATE TABLE x (id int);" }, "postgres:18", "2.0.0");

    const lines = section(previous, current).split("\n").filter((line) => line.startsWith("- "));

    expect(lines.map((line) => /\*\*([^*]+)\*\*/.exec(line)?.[1])).toEqual(["Start over required.", "Postgres major upgrade: dump and restore required.", "Source plugins built for SDK 1.0.0 will not load."]);
  });
});

describe("the Postgres major version of a compose file", () => {
  it.each([
    ["postgres:17", 17],
    ["postgres:17.5-alpine", 17],
    ["postgres:17@sha256:0123456789abcdef", 17],
    ["postgres:18", 18],
  ])("reads %s as %i", (image, major) => {
    expect(postgresMajorOf(compose(image))).toBe(major);
  });

  it.each(["postgres:latest", "postgres", "ghcr.io/other/postgres:17"])("finds no major version in %s", (image) => {
    expect(postgresMajorOf(compose(image))).toBeNull();
  });
});
