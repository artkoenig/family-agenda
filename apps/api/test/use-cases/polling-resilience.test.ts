import type { SourceId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls } from "../support/test-source-plugin";

const minutes = 60 * 1000;

describe("Polling of slow and broken plugins", () => {
  let instance: TestInstance;
  let source: SourceId;
  /** Lets go of every run held by a test, so that none outlives it. */
  let releases: (() => void)[];

  const add = async (sourceTypeId: string): Promise<SourceId> => {
    await instance.app.sourceTypes.enable(sourceTypeId);
    const added = await instance.app.sources.add({ sourceTypeId, plain: { url: "https://portal.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    return added.id;
  };
  const hold = (sourceTypeId: string) => {
    const release = testPluginControls.hold(sourceTypeId);
    releases.push(release);
    return release;
  };
  /** Runs of the plugin since the test began; the test plugins count across tests. */
  let runsBefore: Map<string, number>;
  const runsOf = (sourceTypeId: string) => testPluginControls.runs(sourceTypeId).length - (runsBefore.get(sourceTypeId) ?? 0);
  const health = async (id = source) => (await instance.app.sources.list()).find((s) => s.id === id)?.health;

  beforeEach(async () => {
    releases = [];
    runsBefore = new Map(["school-portal", "club-calendar"].map((id) => [id, testPluginControls.runs(id).length]));
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin; plugins get half a second.
    instance = await bootForTest({
      sourcePlugins: [{ sourceTypeId: "school-portal" }, { sourceTypeId: "club-calendar" }],
      pluginTimeoutMs: 500,
    });
    source = await add("school-portal");
  });
  afterEach(async () => {
    for (const release of releases) release();
    await instance.close();
  });

  it("never runs a Source in two workers at once", async () => {
    const release = hold("school-portal");
    const first = instance.app.polling.pollDue();
    await vi.waitFor(() => { expect(runsOf("school-portal")).toBe(1); });

    const second = await instance.app.polling.pollDue();

    expect(second.polled).toEqual([]);
    expect(runsOf("school-portal")).toBe(1);
    release();
    expect((await first).polled).toEqual([source]);
  });

  it("never runs a Source in two worker processes at once", async () => {
    const other = await instance.bootAnother();
    const release = hold("school-portal");
    const first = instance.app.polling.pollDue();
    await vi.waitFor(() => { expect(runsOf("school-portal")).toBe(1); });

    expect((await other.polling.pollDue()).polled).toEqual([]);

    release();
    expect((await first).polled).toEqual([source]);
    expect((await other.polling.pollDue()).polled).toEqual([]);
    expect(runsOf("school-portal")).toBe(1);
  });

  it("lets the next run take a Source again once a run is over", async () => {
    await instance.app.polling.pollDue();
    instance.clock.advance(10 * minutes);

    expect((await instance.app.polling.pollDue()).polled).toEqual([source]);
  });

  it("cuts off a run that hangs and records it as a temporary failure", async () => {
    hold("school-portal");

    const report = await instance.app.polling.pollDue();

    expect(report.failed).toEqual([{ sourceId: source, kind: "temporary", message: "The plugin did not answer within 0.5 seconds." }]);
    expect((await health())?.problem).toEqual({ kind: "run-failed", message: "The plugin did not answer within 0.5 seconds." });
  });

  it("ends the plugin's call of a run that hangs once the Instance no longer waits for it", async () => {
    hold("school-portal");
    const before = testPluginControls.givenUp("school-portal");

    await instance.app.polling.pollDue();

    await vi.waitFor(() => { expect(testPluginControls.givenUp("school-portal")).toBe(before + 1); });
  });

  it("waits twice as long after each failed run in a row, and as usual again after a successful one", async () => {
    testPluginControls.failNext("school-portal", "temporary");
    await instance.app.polling.pollDue();
    testPluginControls.failNext("school-portal", "temporary");
    instance.clock.advance(10 * minutes);
    await instance.app.polling.pollDue();
    expect(runsOf("school-portal")).toBe(2);

    // Two failures in a row: 20 minutes instead of 10.
    instance.clock.advance(10 * minutes);
    expect((await instance.app.polling.pollDue()).polled).toEqual([]);
    expect(await instance.app.polling.nextDueAt()).toEqual(new Date("2026-09-14T07:30:00Z"));
    instance.clock.advance(10 * minutes);
    expect((await instance.app.polling.pollDue()).polled).toEqual([source]);

    instance.clock.advance(10 * minutes);
    expect((await instance.app.polling.pollDue()).polled).toEqual([source]);
  });

  it("waits at most 6 hours however often runs failed", async () => {
    await instance.query("UPDATE source_run SET consecutive_failures = 30, last_run_at = '2026-09-14T07:00:00Z'");

    expect(await instance.app.polling.nextDueAt()).toEqual(new Date("2026-09-14T13:00:00Z"));
  });

  it("does not let a slow Source delay the Sources of other plugins", async () => {
    const club = await add("club-calendar");
    const release = hold("school-portal");
    const polling = instance.app.polling.pollDue();

    await vi.waitFor(async () => { expect((await health(club))?.lastSuccessAt).not.toBeNull(); });

    expect((await health())?.lastSuccessAt).toBeNull();
    release();
    expect((await polling).polled.toSorted()).toEqual([source, club].toSorted());
  });

});
