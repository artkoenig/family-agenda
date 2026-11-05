import type { Origin } from "@family-agenda/source-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls } from "../support/test-source-plugin";

const minutes = 60 * 1000;

const announcement = (externalId: string, title = "Parents' evening"): Origin => ({
  externalId,
  sender: "School", attributes: ["main"],
  content: { kind: "stated", stated: { kind: "event", title, span: { allDay: true, firstDay: "2026-09-20", lastDay: "2026-09-20" }, place: null, cancelled: false } },
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
    testPluginControls.emit("school-portal", [announcement("evening")]);

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
    testPluginControls.emit("school-portal", [announcement("evening")]);

    await tick();

    await execute(healed("source_run"));
    expect(await origins()).toBe(0);
    expect(await cursor()).toBe("1");
  });

  it("records the rest of the run when a stated Item fails a check of the schema, and warns of it", async () => {
    await execute(["ALTER TABLE event ADD CONSTRAINT event_title_not_secret CHECK (title <> 'Secret')"]);
    testPluginControls.emit("school-portal", [announcement("secret", "Secret"), announcement("evening")]);

    instance.clock.advance(10 * minutes);
    const report = await instance.app.polling.pollDue();

    expect(report.invalid).toMatchObject([{ externalId: "secret", problems: [expect.stringContaining("event_title_not_secret")] }]);
    expect(await instance.query("SELECT r.external_id, r.processed_at IS NOT NULL AS processed, count(i.id)::int AS items FROM source_record r LEFT JOIN item i ON i.record_id = r.id GROUP BY r.id ORDER BY r.external_id")).toEqual([
      { external_id: "evening", processed: true, items: 1 },
      { external_id: "secret", processed: false, items: 0 },
    ]);
    expect(await instance.query("SELECT invalid_records FROM source_run")).toEqual([{ invalid_records: ["secret"] }]);
  });

  it("fails the run on any other error writing a stated Item", async () => {
    await execute(failing("event", "INSERT"));
    testPluginControls.emit("school-portal", [announcement("evening")]);

    instance.clock.advance(10 * minutes);
    await expect(instance.app.polling.pollDue()).rejects.toThrow();

    await execute(healed("event"));
    expect(await origins()).toBe(0);
  });
});
