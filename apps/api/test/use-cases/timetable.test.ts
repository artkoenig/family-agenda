import type { Origin, PluginRevision } from "@family-agenda/source-sdk";
import { openViewAccess } from "@family-agenda/application";
import type { FamilyMemberId, SourceId, ViewId } from "@family-agenda/domain";
import ICAL from "ical.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { icsFeed } from "../../src/http/ics-feed";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";

const minutes = 60 * 1000;

/**
 * One Lesson of a Timetable, as a timetable Source states it at the time it was polled, with its
 * Timetable Change under a key of its own.
 */
const timetableLesson = (
  key: string,
  polledAt: string,
  revisions: Omit<PluginRevision, "itemKey">[],
): Origin => ({
  externalId: key,
  occurredAt: new Date(polledAt),
  attributes: {},
  content: {
    kind: "revisions",
    revisions: revisions.map((revision) => ({ ...revision, itemKey: revision.itemKind === "lesson" ? key : `${key}/change` })),
  },
});

/** Berlin is two hours ahead of UTC in September. */
const at = (day: string, from: string, until: string) => ({
  allDay: false,
  start: new Date(`${day}T${from}:00+02:00`).toISOString(),
  end: new Date(`${day}T${until}:00+02:00`).toISOString(),
});

const lesson = (subject: string, span: ReturnType<typeof at>, room: string | null = "101", teacher: string | null = "Mr Brandt") =>
  ({ itemKind: "lesson", action: "create", fields: { subject, span, room, teacher } }) as const;

/** The Lesson does not take place; the create each Lesson's Origin starts with says that it does again. */
const lessonCancelled = { itemKind: "lesson", action: "cancel", fields: {} } as const;

const cancellation = (subject: string, span: ReturnType<typeof at>, note: string | null = null) =>
  ({
    itemKind: "timetable-change",
    action: "create",
    fields: { change: "cancellation", subject, span, room: null, teacher: null, previousRoom: null, previousTeacher: null, note },
  }) as const;
const changeWithdrawn = { itemKind: "timetable-change", action: "cancel", fields: {} } as const;

const maths = (polledAt: string, ...more: Omit<PluginRevision, "itemKey">[]) =>
  timetableLesson("maths", polledAt, [lesson("Maths", at("2026-09-15", "08:00", "08:45")), ...more]);
const english = (polledAt: string, ...more: Omit<PluginRevision, "itemKey">[]) =>
  timetableLesson("english", polledAt, [lesson("English", at("2026-09-15", "08:50", "09:35"), "102", "Ms Weber"), ...more]);
const physics = (polledAt: string, ...more: Omit<PluginRevision, "itemKey">[]) =>
  timetableLesson("physics", polledAt, [lesson("Physics", at("2026-09-15", "09:55", "10:40"), "Lab", null), ...more]);

describe("Timetables on the timeline and in the feed", () => {
  let instance: TestInstance;
  let untis: SourceId;
  let mia: FamilyMemberId;
  let view: ViewId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootForTest();
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "timetable" });
    await instance.restart();
    await instance.app.sourceTypes.enable("timetable");
    const added = await instance.app.sources.add({ sourceTypeId: "timetable", plain: { url: "https://school.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    untis = added.id;
    const member = await instance.app.familyMembers.add({ name: "Mia" });
    if (!member.ok) throw new Error(`adding failed: ${member.problem}`);
    mia = member.id;
    const assigned = await instance.app.sources.assign(untis, [mia]);
    if (!assigned.ok) throw new Error(`assigning failed: ${assigned.problem}`);
    const created = await instance.app.views.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    view = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The Source states the Lessons on its next run, and the worker runs it. */
  const arrive = async (...origins: Origin[]) => {
    testPluginControls.emit("timetable", origins);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
  };

  /** Tuesday as its school-day rows, with their Lessons, and its Timetable Change rows. */
  const tuesday = async () => {
    const page = await instance.app.views.open(view, { access: openViewAccess });
    const day = page?.days.find((candidate) => candidate.date === "2026-09-15");
    return {
      school: (day?.schoolDays ?? []).map((row) => ({
        from: row.from,
        until: row.until,
        cancelled: row.cancelled,
        concerns: row.concerns,
        lessons: row.lessons.map(
          (one) =>
            [`${one.from}-${one.until}`, one.subject, one.room, one.teacher, one.cancelled ? "(cancelled)" : null].filter(Boolean).join(" "),
        ),
      })),
      changes: (day?.timetableChanges ?? []).map((row) => ({ from: row.from, change: row.change, subject: row.subject })),
    };
  };

  it("collapses a Family Member's Lessons of a day into one school-day row, until the last Lesson ends", async () => {
    await arrive(physics("2026-09-14T07:00:00Z"), maths("2026-09-14T07:00:00Z"), english("2026-09-14T07:00:00Z"));

    expect(await tuesday()).toEqual({
      school: [
        {
          from: "08:00",
          until: "10:40",
          cancelled: false,
          concerns: [mia],
          lessons: ["08:00-08:45 Maths 101 Mr Brandt", "08:50-09:35 English 102 Ms Weber", "09:55-10:40 Physics Lab"],
        },
      ],
      changes: [],
    });
  });

  it("shows a cancelled Lesson as its own highlighted row, and ends the school day with the last Lesson that takes place", async () => {
    await arrive(maths("2026-09-14T07:00:00Z"), english("2026-09-14T07:00:00Z"), physics("2026-09-14T07:00:00Z"));

    await arrive(physics("2026-09-14T07:15:00Z", lessonCancelled, cancellation("Physics", at("2026-09-15", "09:55", "10:40"), "Teacher ill")));

    expect(await tuesday()).toEqual({
      school: [
        {
          from: "08:00",
          until: "09:35",
          cancelled: false,
          concerns: [mia],
          lessons: ["08:00-08:45 Maths 101 Mr Brandt", "08:50-09:35 English 102 Ms Weber", "09:55-10:40 Physics Lab (cancelled)"],
        },
      ],
      changes: [{ from: "09:55", change: "cancellation", subject: "Physics" }],
    });
  });

  it("drops a cancellation the school withdrew, and the Lesson takes place again", async () => {
    await arrive(maths("2026-09-14T07:00:00Z"), english("2026-09-14T07:00:00Z"), physics("2026-09-14T07:00:00Z"));
    await arrive(physics("2026-09-14T07:15:00Z", lessonCancelled, cancellation("Physics", at("2026-09-15", "09:55", "10:40"))));

    await arrive(physics("2026-09-14T07:30:00Z", changeWithdrawn));

    expect(await tuesday()).toMatchObject({
      school: [
        {
          from: "08:00",
          until: "10:40",
          cancelled: false,
          lessons: ["08:00-08:45 Maths 101 Mr Brandt", "08:50-09:35 English 102 Ms Weber", "09:55-10:40 Physics Lab"],
        },
      ],
      changes: [],
    });
  });

  it("drops a Lesson the school no longer plans", async () => {
    await arrive(maths("2026-09-14T07:00:00Z"), english("2026-09-14T07:00:00Z"), physics("2026-09-14T07:00:00Z"));

    testPluginControls.withdraw("timetable", ["physics"]);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();

    expect((await tuesday()).school).toMatchObject([{ until: "09:35", lessons: ["08:00-08:45 Maths 101 Mr Brandt", "08:50-09:35 English 102 Ms Weber"] }]);
  });

  it("cancels the school day when every Lesson of it is cancelled", async () => {
    await arrive(
      maths("2026-09-14T07:00:00Z", lessonCancelled, cancellation("Maths", at("2026-09-15", "08:00", "08:45"))),
      english("2026-09-14T07:00:00Z", lessonCancelled, cancellation("English", at("2026-09-15", "08:50", "09:35"))),
    );

    expect((await tuesday()).school).toMatchObject([{ from: "08:00", until: "09:35", cancelled: true }]);
  });

  describe("in the feed", () => {
    let leo: FamilyMemberId;
    beforeEach(async () => {
      await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "timetable-leo" });
      await instance.restart();
      await instance.app.sourceTypes.enable("timetable-leo");
      const added = await instance.app.sources.add({ sourceTypeId: "timetable-leo", plain: { url: "https://school.example.org" }, secrets: {} });
      if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
      const member = await instance.app.familyMembers.add({ name: "Leo" });
      if (!member.ok) throw new Error(`adding failed: ${member.problem}`);
      leo = member.id;
      const assigned = await instance.app.sources.assign(added.id, [leo]);
      if (!assigned.ok) throw new Error(`assigning failed: ${assigned.problem}`);
    });

    /** Leo's Source states the Lessons on its next run, and the worker runs it. */
    const arriveForLeo = async (...origins: Origin[]) => {
      testPluginControls.emit("timetable-leo", origins);
      instance.clock.advance(15 * minutes);
      await instance.app.polling.pollDue();
    };

    /** The feed's VEVENTs as their main properties, parsed as a calendar app would. */
    const feed = async (id: ViewId = view) => {
      const found = await instance.app.views.feed(id, { access: openViewAccess });
      const text = icsFeed(found!, `http://agenda.local/views/${id}`);
      const calendar = new ICAL.Component(ICAL.parse(text) as unknown[]);
      return calendar.getAllSubcomponents("vevent").map((vevent) => ({
        uid: vevent.getFirstPropertyValue("uid"),
        summary: vevent.getFirstPropertyValue("summary"),
        start: (vevent.getFirstPropertyValue("dtstart") as ICAL.Time).toString(),
        end: (vevent.getFirstPropertyValue("dtend") as ICAL.Time).toString(),
        status: vevent.getFirstPropertyValue("status"),
        description: vevent.getFirstPropertyValue("description"),
      }));
    };

    it("carries one all-day School entry per Family Member and school day, listing its Lessons and marking its Timetable Changes", async () => {
      await arrive(
        maths("2026-09-14T07:00:00Z"),
        english("2026-09-14T07:00:00Z"),
        physics("2026-09-14T07:00:00Z", lessonCancelled, cancellation("Physics", at("2026-09-15", "09:55", "10:40"), "Teacher ill")),
      );
      await arriveForLeo(
        timetableLesson("art", "2026-09-14T07:00:00Z", [lesson("Art", at("2026-09-15", "08:00", "09:35"), "Studio", "Ms Kraus")]),
        timetableLesson("music", "2026-09-14T07:00:00Z", [
          lesson("Music", at("2026-09-16", "08:00", "08:45")),
          lessonCancelled,
          cancellation("Music", at("2026-09-16", "08:00", "08:45")),
        ]),
      );

      expect(await feed()).toMatchObject([
        {
          summary: "⚠ Mia: School",
          start: "2026-09-15",
          end: "2026-09-16",
          status: null,
          description: `08:00 – 08:45 Maths\n08:50 – 09:35 English\n09:55 – 10:40 Physics: cancelled (Teacher ill)\n\nhttp://agenda.local/views/${view}`,
        },
        {
          summary: "Leo: School",
          start: "2026-09-15",
          end: "2026-09-16",
          status: null,
          description: `08:00 – 09:35 Art\n\nhttp://agenda.local/views/${view}`,
        },
        { summary: "⚠ Leo: School", start: "2026-09-16", end: "2026-09-17", status: "CANCELLED" },
      ]);
    });

    it("keeps a School entry's UID as a Timetable Change arrives and is withdrawn, which takes its ⚠ away again", async () => {
      await arrive(maths("2026-09-14T07:00:00Z"), physics("2026-09-14T07:00:00Z"));
      const before = await feed();

      await arrive(physics("2026-09-14T07:15:00Z", lessonCancelled, cancellation("Physics", at("2026-09-15", "09:55", "10:40"))));

      expect((await feed()).map(({ uid, summary }) => ({ uid, summary }))).toEqual([{ uid: before[0]?.uid, summary: "⚠ Mia: School" }]);

      await arrive(physics("2026-09-14T07:30:00Z", changeWithdrawn));

      expect((await feed()).map(({ uid, summary, status }) => ({ uid, summary, status }))).toEqual([
        { uid: before[0]?.uid, summary: "Mia: School", status: null },
      ]);
    });

    it("names no one in the titles of a feed for one Family Member, and leaves out the others", async () => {
      const created = await instance.app.views.create({ preselected: [mia], horizonDays: 7 });
      if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
      await arrive(maths("2026-09-14T07:00:00Z"));
      await arriveForLeo(timetableLesson("art", "2026-09-14T07:00:00Z", [lesson("Art", at("2026-09-15", "08:00", "09:35"))]));

      expect((await feed(created.id)).map(({ summary }) => summary)).toEqual(["School"]);
    });
  });
});
