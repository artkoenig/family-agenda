import type { LocalDate } from "@family-agenda/domain";
import { describe, expect, it } from "vitest";
import type { IngestedRevision, StatedItem } from "../src/ports";
import { applyRevisions } from "../src/stated-items";

const revision = (itemKind: IngestedRevision["itemKind"], act: IngestedRevision["act"], fields: Record<string, unknown> = {}): IngestedRevision => ({
  itemKind,
  itemKey: "entry",
  act,
  fields,
});

const span = { allDay: false, start: "2026-09-15T14:00:00.000Z", end: "2026-09-15T15:00:00.000Z" };
const timed = { start: new Date(span.start), end: new Date(span.end) };

const piano: StatedItem = { kind: "event", event: { title: "Piano lesson", span: { allDay: false, ...timed }, place: "Music school", cancelled: false } };

const physics = (change: Extract<StatedItem, { kind: "lesson" }>["change"] = null): StatedItem => ({
  kind: "lesson",
  lesson: { subject: "Physics", span: timed, room: "Lab", teacher: "Ms Weber" },
  change,
});

const cancellation = { change: "cancellation" as const, previousRoom: null, previousTeacher: null, note: null };

describe("applying a plugin's Revisions to its entry's one Item", () => {
  it("creates an Event and overwrites it with later changes and moves", () => {
    const created = applyRevisions(null, [revision("event", "create", { title: "Piano lesson", span, place: "Music school" })]);
    expect(created).toEqual(piano);

    const later = { allDay: false, start: "2026-09-15T15:00:00.000Z", end: "2026-09-15T16:00:00.000Z" };
    expect(applyRevisions(created, [revision("event", "move", { span: later }), revision("event", "change", { title: "Recital" })])).toEqual({
      kind: "event",
      event: { title: "Recital", span: { allDay: false, start: new Date(later.start), end: new Date(later.end) }, place: "Music school", cancelled: false },
    });
  });

  it("cancels an Event, and a create restores it", () => {
    const cancelled = applyRevisions(piano, [revision("event", "cancel")]);
    expect(cancelled).toMatchObject({ event: { cancelled: true } });
    expect(applyRevisions(cancelled, [revision("event", "change", { place: "Hall" })])).toMatchObject({ event: { cancelled: true, place: "Hall" } });
    expect(applyRevisions(cancelled, [revision("event", "create", { title: "Piano lesson", span })])).toMatchObject({ event: { cancelled: false } });
  });

  it("keeps an all-day Event's days", () => {
    const days = { allDay: true, firstDay: "2026-09-14", lastDay: "2026-09-15" };
    const trip = applyRevisions(null, [revision("event", "create", { title: "Class trip", span: days })]);
    expect(applyRevisions(trip, [revision("event", "change", { place: "Zoo" })])).toEqual({
      kind: "event",
      event: { title: "Class trip", span: days, place: "Zoo", cancelled: false },
    });
  });

  it("leaves out a Revision whose fields cannot apply, and a Notice", () => {
    expect(applyRevisions(piano, [revision("event", "change", { title: "" })])).toEqual(piano);
    expect(applyRevisions(null, [revision("notice", "create", { title: "Photos are online" })])).toBeNull();
    expect(applyRevisions(piano, [revision("notice", "create", { title: "Photos are online" })])).toEqual(piano);
  });

  it("states no Item for an entry that never got a title or time", () => {
    expect(applyRevisions(null, [revision("event", "change", { title: "Recital" })])).toBeNull();
    expect(applyRevisions(null, [])).toBeNull();
  });

  it("writes a Task, keeping what it was", () => {
    const task = applyRevisions(null, [revision("task", "create", { title: "Bring sports kit", deadline: "2026-09-16" })]);
    expect(task).toEqual({ kind: "task", task: { title: "Bring sports kit", deadline: "2026-09-16" as LocalDate, bring: [], cancelled: false } });
    expect(applyRevisions(task, [revision("task", "change", { bring: ["Towel"] })])).toMatchObject({ task: { title: "Bring sports kit", bring: ["Towel"] } });
  });

  it("stores a Timetable Change on its Lesson, keeping the Lesson's room, and drops it when the school withdraws it", () => {
    const lesson = applyRevisions(null, [revision("lesson", "create", { subject: "Physics", span, room: "Lab", teacher: "Ms Weber" })]);
    expect(lesson).toEqual(physics());

    const changed = applyRevisions(lesson, [
      revision("timetable-change", "create", { change: "room-change", subject: "Physics", span, room: null, teacher: null, previousRoom: "Lab", previousTeacher: null, note: "Flood" }),
    ]);
    expect(changed).toEqual(physics({ change: "room-change", previousRoom: "Lab", previousTeacher: null, note: "Flood" }));

    expect(applyRevisions(changed, [revision("timetable-change", "cancel")])).toEqual(physics());
  });

  it("stores a Lesson the plugin cancels without a Timetable Change as cancelled, until it takes place again", () => {
    const cancelled = applyRevisions(physics(), [revision("lesson", "cancel")]);
    expect(cancelled).toEqual(physics(cancellation));
    expect(applyRevisions(cancelled, [revision("lesson", "change", { room: "201" })])).toMatchObject({ change: cancellation, lesson: { room: "201" } });

    expect(applyRevisions(cancelled, [revision("lesson", "create", { subject: "Physics", span })])).toEqual(physics());
  });

  it("ignores Revisions of another kind than the entry's Item", () => {
    expect(applyRevisions(piano, [revision("task", "create", { title: "Bring sports kit" })])).toEqual(piano);
  });
});
