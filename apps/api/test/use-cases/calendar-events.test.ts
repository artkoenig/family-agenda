import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Origin, StatedEvent } from "@family-agenda/source-sdk";
import { openAgendaAccess } from "@family-agenda/application";
import type { AgendaId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

const timed = (start: string, end: string) => ({ allDay: false as const, start, end });

/** A calendar entry stating its Event whole, as a calendar Source emits it on every run. */
const entry = (key: string, event: Partial<Omit<StatedEvent, "kind">> & Pick<StatedEvent, "title" | "span">, more: Partial<Origin> = {}): Origin => ({
  externalId: key,
  sender: "Mia's clubs", attributes: ["main"],
  content: { kind: "stated", stated: { kind: "event", place: null, cancelled: false, ...event } },
  ...more,
});

describe("calendar Events on the timeline", () => {
  let instance: TestInstance;
  let agenda: AgendaId;
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
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    agenda = created.id;
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

  /** The rows of the Agenda, per day, as time, title and whether they are cancelled or earlier. */
  const timeline = async (id: AgendaId = agenda) => {
    const page = await openTimeline(instance.app, id, { access: openAgendaAccess });
    return Object.fromEntries(
      (page?.days ?? [])
        .filter((day) => day.items.length > 0)
        .map((day) => [day.date, day.items.map((row) => `${row.from ?? ""}-${row.until ?? ""} ${row.title}${row.cancelled ? " (cancelled)" : ""}${row.earlier ? " (earlier)" : ""}`)]),
    );
  };

  it("shows an Event on every Agenda", async () => {
    const other = await instance.app.agendas.create({ memberIds: [], horizonDays: 3 });
    if (!other.ok) throw new Error("creating failed");

    await arrive(entry("piano", { title: "Piano lesson", span: timed("2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z"), place: "Music school" }));

    expect(await timeline()).toEqual({ "2026-09-15": ["16:00-17:00 Piano lesson"] });
    expect(await timeline(other.id)).toEqual({ "2026-09-15": ["16:00-17:00 Piano lesson"] });
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    expect(page?.days[1]?.items[0]).toMatchObject({
      place: "Music school",
      span: { allDay: false, start: { date: "2026-09-15", time: "16:00" }, end: { date: "2026-09-15", time: "17:00" } },
      links: [],
    });
  });

  const piano = (event: Partial<StatedEvent> = {}, more: Partial<Origin> = {}) =>
    entry("piano", { title: "Piano lesson", span: timed("2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z"), place: "Music school", ...event }, more);

  /** The entry's Source Record and Item, with the transaction that last wrote each. */
  const written = async () =>
    instance.query(
      "SELECT r.xmin::text AS record, r.processed_at IS NOT NULL AS processed, i.id AS item, e.xmin::text AS event FROM source_record r LEFT JOIN item i ON i.record_id = r.id LEFT JOIN event e ON e.item_id = i.id WHERE r.external_id = 'piano'",
    );

  it("writes nothing for an entry stated as it was", async () => {
    await arrive(piano());
    const before = await written();
    expect(before).toMatchObject([{ processed: true }]);

    await arrive(piano());

    expect(await written()).toEqual(before);
  });

  it("overwrites the Event when the calendar states it otherwise, keeping its one Item", async () => {
    await arrive(piano());
    const [before] = await written();

    await arrive(piano({ title: "Piano recital", span: timed("2026-09-15T15:00:00Z", "2026-09-15T16:00:00Z") }));

    expect(await timeline()).toEqual({ "2026-09-15": ["17:00-18:00 Piano recital"] });
    expect(await written()).toMatchObject([{ item: before?.item }]);
    const [counts] = await instance.query("SELECT count(*)::int AS items FROM item");
    expect(counts).toEqual({ items: 1 });
  });

  it("deletes the Event of an entry the calendar withdraws, and writes it as new when the entry comes back", async () => {
    await arrive(piano());
    const [before] = await written();

    testPluginControls.withdraw("calendar", ["piano"]);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
    expect(await timeline()).toEqual({});
    expect(await written()).toMatchObject([{ item: null }]);

    await arrive(piano());
    expect(await timeline()).toEqual({ "2026-09-15": ["16:00-17:00 Piano lesson"] });
    const [after] = await written();
    expect(after?.item).not.toBeNull();
    expect(after?.item).not.toBe(before?.item);
  });

  it("strikes an Event the calendar cancels through until its date has passed, then drops it", async () => {
    await arrive(piano());
    await arrive(piano({ cancelled: true }));

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
      entry("breakfast", { title: "School breakfast", span: timed("2026-09-14T05:30:00Z", "2026-09-14T06:30:00Z") }),
      entry("dentist", { title: "Dentist", span: timed("2026-09-14T13:00:00Z", "2026-09-14T13:30:00Z") }),
      entry("trip", { title: "Class trip", span: { allDay: true, firstDay: "2026-09-14", lastDay: "2026-09-15" } }),
      entry("sleepover", { title: "Sleepover", span: timed("2026-09-14T16:00:00Z", "2026-09-15T07:00:00Z") }),
    );

    expect(await timeline()).toEqual({
      "2026-09-14": ["- Class trip", "07:30-08:30 School breakfast (earlier)", "15:00-15:30 Dentist", "18:00- Sleepover"],
      "2026-09-15": ["- Class trip", "-09:00 Sleepover"],
    });
  });

  it("links an Event to where the calendar shows it", async () => {
    await arrive(piano({}, { link: "https://calendar.example.org/event/piano" }));

    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    expect(page?.days[1]?.items[0]?.links).toEqual([{ url: "https://calendar.example.org/event/piano", source: "calendar" }]);
  });

  it("follows where an unchanged entry comes from without writing its Event again", async () => {
    await arrive(piano());
    const [before] = await written();

    await arrive(piano({}, { link: "https://calendar.example.org/event/piano" }));

    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    expect(page?.days[1]?.items[0]?.links).toEqual([{ url: "https://calendar.example.org/event/piano", source: "calendar" }]);
    expect(await written()).toMatchObject([{ event: before?.event }]);
  });

  it("names an Event's link after its Source once an Admin named it", async () => {
    await arrive(piano({}, { link: "https://calendar.example.org/event/piano" }));
    const [source] = await instance.app.sources.list();
    await instance.app.sources.rename(source!.id, "Music school");

    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    expect(page?.days[1]?.items[0]?.links).toEqual([{ url: "https://calendar.example.org/event/piano", source: "Music school" }]);
  });

  it("writes no Event an entry states invalidly, and warns beside the Source Status until it is valid", async () => {
    const [source] = await instance.app.sources.list();
    await arrive(piano());

    testPluginControls.emit("calendar", [piano({ title: "x".repeat(501) }), entry("dentist", { title: "Dentist", span: timed("2026-09-14T13:00:00Z", "2026-09-14T13:30:00Z") })]);
    instance.clock.advance(15 * minutes);
    const report = await instance.app.polling.pollDue();

    expect(report.invalid).toEqual([{ sourceId: source!.id, externalId: "piano", problems: ["title is not a non-empty text"] }]);
    expect(await timeline()).toEqual({ "2026-09-14": ["15:00-15:30 Dentist"] });
    expect(await written()).toMatchObject([{ processed: false, item: null }]);
    expect(await instance.app.sources.list()).toMatchObject([{ health: { invalidRecords: ["piano"] } }]);
    const [since] = await instance.query("SELECT invalid_records_since FROM source_run");

    // Still invalid on the next run, the warning stays as it was.
    await arrive(piano({ title: "x".repeat(501) }));
    expect(await instance.query("SELECT invalid_records_since FROM source_run")).toEqual([since]);

    await arrive(piano());
    expect(await timeline()).toMatchObject({ "2026-09-15": ["16:00-17:00 Piano lesson"] });
    expect(await instance.app.sources.list()).toMatchObject([{ health: { invalidRecords: [] } }]);
    expect(await instance.query("SELECT invalid_records_since FROM source_run")).toEqual([{ invalid_records_since: null }]);
  });

  it("forgets the warning of an invalid entry the calendar withdraws", async () => {
    await arrive(piano({ title: "" }));
    expect(await instance.app.sources.list()).toMatchObject([{ health: { invalidRecords: ["piano"] } }]);

    testPluginControls.withdraw("calendar", ["piano"]);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();

    expect(await instance.app.sources.list()).toMatchObject([{ health: { invalidRecords: [] } }]);
  });

  it("removes the Events of a removed Source", async () => {
    await arrive(piano());
    const [source] = await instance.app.sources.list();

    await instance.app.sources.remove(source!.id);

    expect(await timeline()).toEqual({});
    expect((await instance.app.agendas.feed(agenda, { access: openAgendaAccess }))?.events).toEqual([]);
    expect(await instance.query("SELECT id FROM item")).toEqual([]);
  });

  it("hides the Events of a hidden Source, and keeps reading it", async () => {
    await arrive(piano());
    const [source] = await instance.app.sources.list();

    await instance.app.sources.setShown(source!.id, false);
    expect(await timeline()).toEqual({});
    expect((await instance.app.agendas.feed(agenda, { access: openAgendaAccess }))?.events).toEqual([]);
    expect(await instance.app.sources.list()).toMatchObject([{ shown: false }]);

    await arrive(piano({ title: "Piano recital" }));
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

  it("runs each Source on its plugin's suggested interval, with its secrets and the sync cursor of its last run", async () => {
    await add("school-cal");
    const runs = () => testPluginControls.runs("school-cal").slice(-3);
    const before = testPluginControls.runs("school-cal").length;

    await instance.app.polling.pollDue();
    instance.clock.advance(9 * minutes);
    await instance.app.polling.pollDue();
    instance.clock.advance(1 * minutes);
    await instance.app.polling.pollDue();

    expect(testPluginControls.runs("school-cal").length - before).toBe(2);
    expect(runs().slice(-2).map(({ syncCursor, config, now, timeZone }) => ({ syncCursor, config, now, timeZone }))).toEqual([
      {
        syncCursor: null,
        config: { plain: { url: "https://calendar.example.org" }, secrets: { password: "hunter2" } },
        now: new Date("2026-09-14T07:00:00Z"),
        timeZone: "Europe/Berlin",
      },
      {
        syncCursor: "1",
        config: { plain: { url: "https://calendar.example.org" }, secrets: { password: "hunter2" } },
        now: new Date("2026-09-14T07:10:00Z"),
        timeZone: "Europe/Berlin",
      },
    ]);
  });

  it("waits for the next interval after a failed run, keeping the sync cursor, and runs the other Sources", async () => {
    const school = await add("school-cal");
    const club = await add("club-cal");
    await instance.app.polling.pollDue();

    instance.clock.advance(10 * minutes);
    testPluginControls.failNext("school-cal", "definite");
    expect(await instance.app.polling.pollDue()).toEqual({
      ran: [club],
      failed: [{ sourceId: school, kind: "definite", message: "school-cal failed" }],
      invalid: [],
      refused: [],
    });
    expect(await instance.app.polling.pollDue()).toEqual({ ran: [], failed: [], invalid: [], refused: [] });

    instance.clock.advance(10 * minutes);
    await instance.app.polling.pollDue();
    expect(testPluginControls.runs("school-cal").at(-1)?.syncCursor).toBe("1");
  });

  it("fails a run whose Origins are invalid, without recording any of them", async () => {
    const school = await add("school-cal");
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 7 });
    if (!created.ok) throw new Error("creating failed");
    testPluginControls.emit("school-cal", [
      entry("ok", { title: "Fine", span: timed("2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z") }),
      { ...entry("bad", { title: "Bad", span: timed("2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z") }), externalId: "" },
    ]);

    const report = await instance.app.polling.pollDue();

    expect(report.failed).toEqual([
      { sourceId: school, kind: "definite", message: "The plugin emitted invalid Origins: the Origin has no external id" },
    ]);
    const page = await openTimeline(instance.app, created.id, { access: openAgendaAccess });
    expect(page?.days.flatMap((day) => day.items)).toEqual([]);
  });

  it("does not run a Source whose plugin was removed", async () => {
    await add("school-cal");
    await rm(join(instance.workspacePackages, "school-cal"), { recursive: true });
    await instance.restart();

    expect(await instance.app.polling.pollDue()).toEqual({ ran: [], failed: [], invalid: [], refused: [] });
  });
});
