import { describe, expect, it } from "vitest";
import type { LocalDate } from "@family-agenda/domain";
import { readStated } from "../src/stated-items";

const span = { allDay: false, start: "2026-09-15T14:00:00.000Z", end: "2026-09-15T15:00:00.000Z" };
const timed = { start: new Date(span.start), end: new Date(span.end) };

const lesson = {
  kind: "lesson",
  subject: "Physics",
  span,
  room: "Lab",
  teacher: "Ms Weber",
  change: null,
  previousRoom: null,
  previousTeacher: null,
  note: null,
};

describe("reading the Item a calendar or timetable entry states", () => {
  it("reads a timed Event", () => {
    expect(readStated({ kind: "event", title: "Piano lesson", span, place: "Music school", cancelled: false })).toEqual({
      ok: true,
      item: { kind: "event", event: { title: "Piano lesson", span: { allDay: false, ...timed }, place: "Music school", cancelled: false } },
    });
  });

  it("reads an all-day Event, cancelled by its Source", () => {
    const allDay = { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-19" };
    expect(readStated({ kind: "event", title: "Trip", span: allDay, place: null, cancelled: true })).toEqual({
      ok: true,
      item: { kind: "event", event: { title: "Trip", span: { allDay: true, firstDay: "2026-09-18" as LocalDate, lastDay: "2026-09-19" as LocalDate }, place: null, cancelled: true } },
    });
  });

  it("reads a Lesson as planned", () => {
    expect(readStated(lesson)).toEqual({
      ok: true,
      item: { kind: "lesson", lesson: { subject: "Physics", span: timed, room: "Lab", teacher: "Ms Weber" }, change: null },
    });
  });

  it("reads a Lesson with its Timetable Change and what it was before", () => {
    const substituted = { ...lesson, change: "substitution", previousTeacher: "Mr Roth", note: "Teacher ill" };
    expect(readStated(substituted)).toEqual({
      ok: true,
      item: {
        kind: "lesson",
        lesson: { subject: "Physics", span: timed, room: "Lab", teacher: "Ms Weber" },
        change: { change: "substitution", previousRoom: null, previousTeacher: "Mr Roth", note: "Teacher ill" },
      },
    });
  });

  it.each([
    { case: "an Event without a title", stated: { kind: "event", span, place: null, cancelled: false }, problems: ["title is missing"] },
    {
      case: "an Event whose title is too long",
      stated: { kind: "event", title: "x".repeat(501), span, place: null, cancelled: false },
      problems: ["title is not a non-empty text"],
    },
    {
      case: "an Event cancelled neither true nor false",
      stated: { kind: "event", title: "Piano", span, place: null, cancelled: "yes" },
      problems: ["cancelled is not true or false"],
    },
    { case: "a Lesson with a previous room but no change", stated: { ...lesson, previousRoom: "101" }, problems: ["previousRoom needs a change"] },
    { case: "a Lesson that ends before it starts", stated: { ...lesson, span: { ...span, end: span.start } }, problems: ["span is not a valid time span of a Lesson"] },
    { case: "a kind of Item no Source states", stated: { kind: "task", title: "Bring milk" }, problems: ['"task" is no kind of Item a Source states'] },
  ])("finds no Item in $case", ({ stated, problems }) => {
    expect(readStated(stated)).toEqual({ ok: false, problems });
  });

  it("reads an Event without a place or cancellation as neither", () => {
    expect(readStated({ kind: "event", title: "Piano", span })).toMatchObject({ ok: true, item: { event: { place: null, cancelled: false } } });
  });
});
