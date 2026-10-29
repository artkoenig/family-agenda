import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Origin, PluginRevision } from "@family-agenda/source-sdk";
import { openViewAccess } from "@family-agenda/application";
import type { ViewId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";

const minutes = 60 * 1000;

/** A calendar entry stating something about an Event, as a structured Source emits it. */
const entry = (
  key: string,
  action: PluginRevision["action"],
  sourceTime: string,
  fields: PluginRevision["fields"] = {},
  more: Partial<Origin> = {},
): Origin => ({
  externalId: key,
  occurredAt: new Date(sourceTime),
  attributes: { sender: "Mia's clubs" },
  content: { kind: "revisions", revisions: [{ itemKind: "event", itemKey: key, action, fields }] },
  ...more,
});

const timed = (start: string, end: string) => ({ allDay: false, start, end });

describe("calendar Events on the timeline", () => {
  let instance: TestInstance;
  let view: ViewId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootForTest();
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "calendar" });
    await instance.restart();
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({
      sourceTypeId: "calendar",
      plain: { url: "https://calendar.example.org" },
      secrets: { password: "hunter2" },
    });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    const created = await instance.app.views.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    view = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The calendar emits the entries on its next run, and the worker runs it. */
  const arrive = async (...origins: Origin[]) => {
    testPluginControls.emit("calendar", origins);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
  };

  /** The rows of the View, per day, as time, title and whether they are cancelled or earlier. */
  const timeline = async (id: ViewId = view) => {
    const page = await instance.app.views.open(id, { access: openViewAccess });
    return Object.fromEntries(
      (page?.days ?? [])
        .filter((day) => day.items.length > 0)
        .map((day) => [day.date, day.items.map((row) => `${row.from ?? ""}-${row.until ?? ""} ${row.title}${row.cancelled ? " (cancelled)" : ""}${row.earlier ? " (earlier)" : ""}`)]),
    );
  };

  it("shows a created Event on every View", async () => {
    const other = await instance.app.views.create({ preselected: [], horizonDays: 3 });
    if (!other.ok) throw new Error("creating failed");

    await arrive(
      entry("piano", "create", "2026-09-01T10:00:00Z", {
        title: "Piano lesson",
        span: timed("2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z"),
        place: "Music school",
      }),
    );

    expect(await timeline()).toEqual({ "2026-09-15": ["16:00-17:00 Piano lesson"] });
    expect(await timeline(other.id)).toEqual({ "2026-09-15": ["16:00-17:00 Piano lesson"] });
    const page = await instance.app.views.open(view, { access: openViewAccess });
    expect(page?.days[1]?.items[0]).toMatchObject({
      place: "Music school",
      span: { allDay: false, start: { date: "2026-09-15", time: "16:00" }, end: { date: "2026-09-15", time: "17:00" } },
      links: [],
    });
  });

  const piano = (sourceTime = "2026-09-01T10:00:00Z") =>
    entry("piano", "create", sourceTime, {
      title: "Piano lesson",
      span: timed("2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z"),
      place: "Music school",
    });
  const moveToFive = entry("piano", "move", "2026-09-10T08:00:00Z", {
    span: timed("2026-09-15T15:00:00Z", "2026-09-15T16:00:00Z"),
  });
  const rename = entry("piano", "change", "2026-09-11T08:00:00Z", { title: "Piano recital" });

  it("updates the Event when the calendar later changes or moves it", async () => {
    await arrive(piano());

    await arrive(moveToFive);
    expect(await timeline()).toEqual({ "2026-09-15": ["17:00-18:00 Piano lesson"] });

    await arrive(rename);
    expect(await timeline()).toEqual({ "2026-09-15": ["17:00-18:00 Piano recital"] });
  });

  it("ends up with the same Event whatever order the Revisions arrive in", async () => {
    await arrive(rename);
    expect(await timeline(), "a change alone has no time to show").toEqual({});
    await arrive(moveToFive);
    await arrive(piano());

    expect(await timeline()).toEqual({ "2026-09-15": ["17:00-18:00 Piano recital"] });
  });

  it("appends nothing when a calendar states the same thing again", async () => {
    await arrive(piano());
    await arrive(rename);
    await arrive(piano());

    expect(await timeline()).toEqual({ "2026-09-15": ["16:00-17:00 Piano recital"] });
    // Folding gives the same Item either way; the change list (#44) will show the difference.
    const [counts] = await instance.query("SELECT count(*)::int AS revisions FROM revisions");
    expect(counts).toEqual({ revisions: 2 });
  });

  it("strikes a cancelled Event through until its date has passed, then drops it", async () => {
    await arrive(piano());
    await arrive(entry("piano", "cancel", "2026-09-12T08:00:00Z"));

    expect(await timeline()).toEqual({ "2026-09-15": ["16:00-17:00 Piano lesson (cancelled)"] });

    // Tuesday evening, after the lesson: still today, dimmed.
    instance.clock.advance(33 * 60 * minutes);
    expect(await timeline()).toEqual({ "2026-09-15": ["16:00-17:00 Piano lesson (cancelled) (earlier)"] });

    // Wednesday: the date has passed.
    instance.clock.advance(6 * 60 * minutes);
    expect(await timeline()).toEqual({});
  });

  it("dims Events of today that are over, and orders a day's rows by time, all-day ones first", async () => {
    await arrive(
      entry("breakfast", "create", "2026-09-01T10:00:00Z", {
        title: "School breakfast",
        span: timed("2026-09-14T05:30:00Z", "2026-09-14T06:30:00Z"),
      }),
      entry("dentist", "create", "2026-09-01T10:00:00Z", {
        title: "Dentist",
        span: timed("2026-09-14T13:00:00Z", "2026-09-14T13:30:00Z"),
      }),
      entry("trip", "create", "2026-09-01T10:00:00Z", {
        title: "Class trip",
        span: { allDay: true, firstDay: "2026-09-14", lastDay: "2026-09-15" },
      }),
      entry("sleepover", "create", "2026-09-01T10:00:00Z", {
        title: "Sleepover",
        span: timed("2026-09-14T16:00:00Z", "2026-09-15T07:00:00Z"),
      }),
    );

    expect(await timeline()).toEqual({
      "2026-09-14": ["- Class trip", "07:30-08:30 School breakfast (earlier)", "15:00-15:30 Dentist", "18:00- Sleepover"],
      "2026-09-15": ["- Class trip", "-09:00 Sleepover"],
    });
  });

  it("links an Event to where the calendar shows it", async () => {
    await arrive({ ...piano(), link: "https://calendar.example.org/event/piano" });
    await arrive(rename);

    const page = await instance.app.views.open(view, { access: openViewAccess });
    expect(page?.days[1]?.items[0]?.links).toEqual([{ url: "https://calendar.example.org/event/piano", source: "calendar" }]);
  });

  it("names an Event's link after its Source once an Admin named it", async () => {
    await arrive({ ...piano(), link: "https://calendar.example.org/event/piano" });
    const [source] = await instance.app.sources.list();
    await instance.app.sources.rename(source!.id, "Music school");

    const page = await instance.app.views.open(view, { access: openViewAccess });
    expect(page?.days[1]?.items[0]?.links).toEqual([{ url: "https://calendar.example.org/event/piano", source: "Music school" }]);
  });

  it("rejects a Revision whose fields an Event cannot have, and keeps the rest", async () => {
    await arrive(piano());
    await arrive(entry("piano", "change", "2026-09-11T08:00:00Z", { title: "" }));
    await arrive(entry("broken", "create", "2026-09-11T08:00:00Z", { title: "No time" }));

    expect(await timeline()).toEqual({ "2026-09-15": ["16:00-17:00 Piano lesson"] });
  });

  it("removes the Events of a removed Source", async () => {
    await arrive(piano());
    const [source] = await instance.app.sources.list();

    await instance.app.sources.remove(source!.id);

    expect(await timeline()).toEqual({});
    expect((await instance.app.views.feed(view, { access: openViewAccess }))?.events).toEqual([]);
    expect(await instance.query("SELECT id FROM items")).toEqual([]);
  });

  it("keeps an Item of a removed Source that another Source names, recomputed without its statements", async () => {
    await arrive(piano());
    const [source] = await instance.app.sources.list();
    const other = await instance.app.sources.add({
      sourceTypeId: "calendar",
      plain: { url: "https://other.example.org" },
      secrets: { password: "hunter2" },
    });
    if (!other.ok) throw new Error(`adding failed: ${other.problem}`);
    const [, otherSource] = await instance.app.sources.list();
    await instance.query(
      `INSERT INTO item_keys (source_id, item_key, item_id) SELECT '${otherSource!.id}', item_key, item_id FROM item_keys`,
    );

    await instance.app.sources.remove(source!.id);

    expect(await timeline()).toEqual({});
    expect(await instance.query("SELECT folded FROM items")).toEqual([{ folded: null }]);
  });

  it("hides the Events of a hidden Source, and keeps reading it", async () => {
    await arrive(piano());
    const [source] = await instance.app.sources.list();

    await instance.app.sources.setShown(source!.id, false);
    expect(await timeline()).toEqual({});
    expect((await instance.app.views.feed(view, { access: openViewAccess }))?.events).toEqual([]);
    expect(await instance.app.sources.list()).toMatchObject([{ shown: false }]);

    await arrive(rename);
    await instance.app.sources.setShown(source!.id, true);
    expect(await timeline()).toEqual({ "2026-09-15": ["16:00-17:00 Piano recital"] });
  });
});

describe("polling Sources", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
    for (const sourceTypeId of ["school-cal", "club-cal", "idle-cal"]) {
      await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId });
    }
    await instance.restart();
    await instance.app.sourceTypes.enable("school-cal");
    await instance.app.sourceTypes.enable("club-cal");
  });
  afterEach(async () => {
    await instance.close();
  });

  const add = async (sourceTypeId: string) => {
    const added = await instance.app.sources.add({
      sourceTypeId,
      plain: { url: "https://calendar.example.org" },
      secrets: { password: "hunter2" },
    });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    return added.id;
  };

  it("runs each Source on its plugin's suggested interval, with its secrets and the state of its last run", async () => {
    await add("school-cal");
    const runs = () => testPluginControls.runs("school-cal").slice(-3);
    const before = testPluginControls.runs("school-cal").length;

    await instance.app.polling.pollDue();
    instance.clock.advance(9 * minutes);
    await instance.app.polling.pollDue();
    instance.clock.advance(1 * minutes);
    await instance.app.polling.pollDue();

    expect(testPluginControls.runs("school-cal").length - before).toBe(2);
    expect(runs().slice(-2).map(({ state, config, now, timeZone }) => ({ state, config, now, timeZone }))).toEqual([
      {
        state: null,
        config: { plain: { url: "https://calendar.example.org" }, secrets: { password: "hunter2" } },
        now: new Date("2026-09-14T07:00:00Z"),
        timeZone: "Europe/Berlin",
      },
      {
        state: "1",
        config: { plain: { url: "https://calendar.example.org" }, secrets: { password: "hunter2" } },
        now: new Date("2026-09-14T07:10:00Z"),
        timeZone: "Europe/Berlin",
      },
    ]);
  });

  it("waits for the next interval after a failed run, keeping the state, and runs the other Sources", async () => {
    const school = await add("school-cal");
    const club = await add("club-cal");
    await instance.app.polling.pollDue();

    instance.clock.advance(10 * minutes);
    testPluginControls.failNext("school-cal", "definite");
    expect(await instance.app.polling.pollDue()).toEqual({
      polled: [club],
      failed: [{ sourceId: school, kind: "definite", message: "school-cal failed" }],
    });
    expect(await instance.app.polling.pollDue()).toEqual({ polled: [], failed: [] });

    instance.clock.advance(10 * minutes);
    await instance.app.polling.pollDue();
    expect(testPluginControls.runs("school-cal").at(-1)?.state).toBe("1");
  });

  it("fails a run whose Origins are invalid, without recording any of them", async () => {
    const school = await add("school-cal");
    const created = await instance.app.views.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error("creating failed");
    testPluginControls.emit("school-cal", [
      entry("ok", "create", "2026-09-01T10:00:00Z", { title: "Fine", span: timed("2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z") }),
      { ...entry("bad", "create", "2026-09-01T10:00:00Z"), externalId: "" },
    ]);

    const report = await instance.app.polling.pollDue();

    expect(report.failed).toEqual([
      { sourceId: school, kind: "definite", message: "The plugin emitted invalid Origins: the Origin has no external id" },
    ]);
    const page = await instance.app.views.open(created.id, { access: openViewAccess });
    expect(page?.days.flatMap((day) => day.items)).toEqual([]);
  });

  it("does not run a Source whose plugin was removed", async () => {
    await add("school-cal");
    await rm(join(instance.workspacePackages, "school-cal"), { recursive: true });
    await instance.restart();

    expect(await instance.app.polling.pollDue()).toEqual({ polled: [], failed: [] });
  });
});
