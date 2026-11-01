import type { Origin } from "@family-agenda/source-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls } from "../support/test-source-plugin";

const minutes = 60 * 1000;

const notice = (externalId: string): Origin => ({
  externalId,
  occurredAt: new Date("2026-09-14T06:00:00Z"),
  attributes: { sender: "School" },
  content: {
    kind: "revisions",
    revisions: [
      {
        itemKind: "event",
        itemKey: externalId,
        action: "create",
        fields: { title: "Parents' evening", span: { allDay: true, firstDay: "2026-09-20", lastDay: "2026-09-20" } },
      },
    ],
  },
});

/** Makes every such write to the table fail, as a crash in the middle of a run would. */
const failing = (table: string, event: "INSERT" | "UPDATE") => [
  "CREATE FUNCTION fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'write failed'; END $$",
  `CREATE TRIGGER fail_write BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_write()`,
];

/** Takes the failing writes of `failing` away again. */
const healed = (table: string) => [`DROP TRIGGER fail_write ON ${table}`, "DROP FUNCTION fail_write()"];

describe("A Source's run", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootForTest({ sourcePlugins: [{ sourceTypeId: "school-portal" }] });
    await instance.app.sourceTypes.enable("school-portal");
    const added = await instance.app.sources.add({
      sourceTypeId: "school-portal",
      plain: { url: "https://portal.example.org" },
      secrets: {},
    });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The worker's next tick, once the Source's 10-minute interval has passed. */
  const tick = async () => {
    instance.clock.advance(10 * minutes);
    await instance.app.polling.pollDue().catch(() => undefined);
  };

  /** Runs SQL statements against the Instance's database, one at a time. */
  const execute = async (statements: string[]) => {
    for (const statement of statements) await instance.query(statement);
  };
  const cursor = async () => (await instance.query("SELECT sync_cursor FROM source_run"))[0]?.sync_cursor;
  const origins = async () => (await instance.query("SELECT count(*)::int AS count FROM source_record"))[0]?.count;

  it("keeps the sync cursor apart from what an Admin configures", async () => {
    await tick();

    expect(await cursor()).toBe("1");
    const columns = await instance.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'source' AND column_name IN ('state', 'sync_cursor')",
    );
    expect(columns).toEqual([]);
  });

  it("does not advance the sync cursor when its Origins are not recorded", async () => {
    await tick();
    await execute(failing("source_record", "INSERT"));
    testPluginControls.emit("school-portal", [notice("evening")]);

    await tick();

    expect(await origins()).toBe(0);
    expect(await cursor()).toBe("1");
    await execute(healed("source_record"));
    await tick();
    expect(testPluginControls.runs("school-portal").at(-1)?.syncCursor).toBe("1");
  });

  it("does not record its Origins when the sync cursor is not advanced", async () => {
    await tick();
    await execute(failing("source_run", "UPDATE"));
    testPluginControls.emit("school-portal", [notice("evening")]);

    await tick();

    await execute(healed("source_run"));
    expect(await origins()).toBe(0);
    expect(await cursor()).toBe("1");
  });
});
