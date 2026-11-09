import type { Origin, StatedEvent } from "../support/test-source-plugin";
import { openAgendaAccess } from "@family-agenda/application";
import type { AgendaId } from "@family-agenda/domain";
import ICAL from "ical.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { icsFeed } from "../../src/http/ics-feed";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls } from "../support/test-source-plugin";

const minutes = 60 * 1000;
const days = 24 * 60 * minutes;

/** A calendar entry stating its Event whole, as a calendar Source emits it. */
const entry = (key: string, fields: Partial<Omit<StatedEvent, "kind">>): Origin => ({
  externalId: key,
  attributes: ["main"],
  content: { kind: "stated", stated: { kind: "event", place: null, cancelled: false, ...fields } as StatedEvent },
});

const timed = (start: string, end: string) => ({ allDay: false as const, start, end });

const pianoLesson = { title: "Piano lesson", span: timed("2026-09-15T14:00:00Z", "2026-09-15T15:00:00Z"), place: "Music school" };

const piano = entry("piano", pianoLesson);

describe("the ICS feed of an Agenda", () => {
  let instance: TestInstance;
  let agenda: AgendaId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootForTest();
    await instance.installPlugin({ sourceTypeId: "calendar" });
    await instance.restart();
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({
      sourceTypeId: "calendar",
      plain: { url: "https://calendar.example.org" },
      secrets: {},
    });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 3 });
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

  /** The feed's VEVENTs as their main properties, parsed as a calendar app would. */
  const feed = async (id: AgendaId = agenda) => {
    const found = await instance.app.agendas.feed(id, { access: openAgendaAccess });
    if (!found) return null;
    const text = icsFeed(found, `http://agenda.local/agendas/${id}`);
    const calendar = new ICAL.Component(ICAL.parse(text) as unknown[]);
    return calendar.getAllSubcomponents("vevent").map((vevent) => {
      const start = vevent.getFirstPropertyValue("dtstart") as ICAL.Time;
      const end = vevent.getFirstPropertyValue("dtend") as ICAL.Time;
      const time = (value: ICAL.Time) => (value.isDate ? value.toString() : value.toJSDate().toISOString());
      return {
        uid: vevent.getFirstPropertyValue("uid"),
        summary: vevent.getFirstPropertyValue("summary"),
        start: time(start),
        end: time(end),
        location: vevent.getFirstPropertyValue("location"),
        status: vevent.getFirstPropertyValue("status"),
        description: vevent.getFirstPropertyValue("description"),
      };
    });
  };

  it("carries the Family's Events with their time, place and the details of the Agenda", async () => {
    await arrive(
      piano,
      entry("trip", {
        title: "Class trip",
        span: { allDay: true, firstDay: "2026-09-16", lastDay: "2026-09-17" },
      }),
    );

    const events = await feed();

    expect(events).toMatchObject([
      {
        summary: "Piano lesson",
        start: "2026-09-15T14:00:00.000Z",
        end: "2026-09-15T15:00:00.000Z",
        location: "Music school",
        status: null,
        description: `Tue 15 Sept, 16:00 – 17:00\nMusic school\n\nhttp://agenda.local/agendas/${agenda}`,
      },
      {
        summary: "Class trip",
        start: "2026-09-16",
        end: "2026-09-18",
        location: null,
        status: null,
        description: `Wed 16 Sept – Thu 17 Sept\n\nhttp://agenda.local/agendas/${agenda}`,
      },
    ]);
  });

  it("keeps an Event's UID when it changes, so that calendar apps update it in place", async () => {
    await arrive(piano, entry("dentist", { title: "Dentist", span: timed("2026-09-16T08:00:00Z", "2026-09-16T08:30:00Z") }));
    const before = await feed();

    await arrive(entry("piano", { ...pianoLesson, span: timed("2026-09-15T15:00:00Z", "2026-09-15T16:00:00Z") }));
    const after = await feed();

    expect(after?.map(({ uid, start }) => ({ uid, start }))).toEqual([
      { uid: before?.[0]?.uid, start: "2026-09-15T15:00:00.000Z" },
      { uid: before?.[1]?.uid, start: "2026-09-16T08:00:00.000Z" },
    ]);
    expect(before?.[0]?.uid).not.toEqual(before?.[1]?.uid);
  });

  it("covers the last 30 days and all of the future, whatever the Agenda's horizon", async () => {
    await arrive(
      entry("late-party", {
        title: "Party until midnight",
        span: timed("2026-08-14T18:00:00Z", "2026-08-14T22:00:00Z"),
      }),
      entry("later-party", {
        title: "Party past midnight",
        span: timed("2026-08-14T18:00:00Z", "2026-08-14T22:30:00Z"),
      }),
      entry("camp", {
        title: "Camp",
        span: { allDay: true, firstDay: "2026-08-10", lastDay: "2026-08-14" },
      }),
      entry("fair", {
        title: "Fair",
        span: { allDay: true, firstDay: "2026-08-15", lastDay: "2026-08-15" },
      }),
      entry("christmas", {
        title: "Christmas next year",
        span: { allDay: true, firstDay: "2027-12-24", lastDay: "2027-12-26" },
      }),
    );

    expect((await feed())?.map((event) => event.summary)).toEqual([
      "Party past midnight",
      "Fair",
      "Christmas next year",
    ]);

    instance.clock.advance(1 * days);
    expect((await feed())?.map((event) => event.summary)).toEqual(["Christmas next year"]);
  });

  it("leaves Items concerning the whole Family out of a feed for chosen Family Members, and keeps them in a whole-Family feed", async () => {
    const mia = await instance.app.familyMembers.add({ name: "Mia" });
    if (!mia.ok) throw new Error("adding failed");
    const forMia = await instance.app.agendas.create({ memberIds: [mia.id], horizonDays: 3 });
    if (!forMia.ok) throw new Error("creating failed");
    await arrive(piano);

    // With no Source assigned to anyone, every Event concerns the whole Family.
    expect((await feed(forMia.id))?.map((event) => event.summary)).toEqual([]);
    expect((await feed())?.map((event) => event.summary)).toEqual(["Piano lesson"]);
  });

  it("keeps its Events when a plugin states an entry without a time, which the plugin contract refuses", async () => {
    // A stated Event needs its span by the contract; the run fails as a whole, unlike an entry that only the domain refuses.
    await arrive(piano);
    testPluginControls.emit("calendar", [piano, entry("broken", { title: "No time" })]);
    instance.clock.advance(15 * minutes);
    const report = await instance.app.polling.pollDue();

    expect(report.failed).toHaveLength(1);
    expect((await feed())?.map((event) => event.summary)).toEqual(["Piano lesson"]);
  });

  it("has no feed for an unknown Agenda or one the access policy refuses", async () => {
    expect(await instance.app.agendas.feed("00000000-0000-4000-8000-000000000000" as AgendaId, { access: openAgendaAccess })).toBeNull();
    const refused = { mayOpen: () => Promise.resolve(false) };
    expect(await instance.app.agendas.feed(agenda, { access: refused })).toBeNull();
  });

  it("sends a cancelled Event as cancelled", async () => {
    await arrive(piano);
    await arrive(entry("piano", { ...pianoLesson, cancelled: true }));

    expect(await feed()).toEqual([
      expect.objectContaining({
        summary: "Piano lesson",
        status: "CANCELLED",
        description: `Tue 15 Sept, 16:00 – 17:00\nMusic school\nCancelled\n\nhttp://agenda.local/agendas/${agenda}`,
      }),
    ]);
  });
});
