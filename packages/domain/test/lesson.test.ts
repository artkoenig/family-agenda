import { describe, expect, it } from "vitest";
import {
  lessonOf,
  maximumLessonTextLength,
  problemsWithLessonRevision,
  problemsWithTimetableChangeRevision,
  timetableChangeKinds,
  timetableChangeOf,
  type Act,
  type FoldedItem,
} from "../src";

const span = (start = "2026-09-15T08:00:00.000Z", end = "2026-09-15T09:00:00.000Z") => ({
  allDay: false,
  start,
  end,
});

const folded = (fields: Record<string, unknown>, more: Partial<FoldedItem> = {}): FoldedItem => ({
  fields,
  cancelled: false,
  ...more,
});

describe("a Lesson Revision", () => {
  it.each([
    {
      case: "a create with all fields",
      act: "create" as Act,
      fields: { subject: "Math", span: span(), room: "201", teacher: "Ms. Smith" },
      problems: [],
    },
    {
      case: "a create without a subject",
      act: "create" as Act,
      fields: { span: span() },
      problems: ["subject is missing"],
    },
    {
      case: "a create without a span",
      act: "create" as Act,
      fields: { subject: "Math" },
      problems: ["span is missing"],
    },
    {
      case: "a move without a span",
      act: "move" as Act,
      fields: { subject: "Math" },
      problems: ["span is missing"],
    },
    {
      case: "a cancel with no fields",
      act: "cancel" as Act,
      fields: {},
      problems: [],
    },
    {
      case: "a change with an empty subject",
      act: "change" as Act,
      fields: { subject: "   " },
      problems: ["subject is not a non-empty text"],
    },
    {
      case: "a subject that is too long",
      act: "change" as Act,
      fields: { subject: "x".repeat(maximumLessonTextLength + 1) },
      problems: ["subject is not a non-empty text"],
    },
    {
      case: "a subject at the maximum length",
      act: "change" as Act,
      fields: { subject: "x".repeat(maximumLessonTextLength) },
      problems: [],
    },
    {
      case: "a subject that is not a string",
      act: "change" as Act,
      fields: { subject: 42 },
      problems: ["subject is not a non-empty text"],
    },
    {
      case: "a span that is not an object",
      act: "change" as Act,
      fields: { span: "2026-09-15T08:00:00.000Z" },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with allDay true",
      act: "change" as Act,
      fields: { span: { allDay: true, firstDay: "2026-09-15", lastDay: "2026-09-15" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with allDay not false",
      act: "change" as Act,
      fields: { span: { allDay: undefined, start: "2026-09-15T08:00:00.000Z", end: "2026-09-15T09:00:00.000Z" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with a non-string start",
      act: "change" as Act,
      fields: { span: { allDay: false, start: 123, end: "2026-09-15T09:00:00.000Z" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with a non-string end",
      act: "change" as Act,
      fields: { span: { allDay: false, start: "2026-09-15T08:00:00.000Z", end: 123 } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with an invalid start date",
      act: "change" as Act,
      fields: { span: { allDay: false, start: "not-a-date", end: "2026-09-15T09:00:00.000Z" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with an invalid end date",
      act: "change" as Act,
      fields: { span: { allDay: false, start: "2026-09-15T08:00:00.000Z", end: "not-a-date" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span where end equals start",
      act: "change" as Act,
      fields: { span: { allDay: false, start: "2026-09-15T08:00:00.000Z", end: "2026-09-15T08:00:00.000Z" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span where end is before start",
      act: "change" as Act,
      fields: { span: { allDay: false, start: "2026-09-15T09:00:00.000Z", end: "2026-09-15T08:00:00.000Z" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a room that is not a string or null",
      act: "change" as Act,
      fields: { room: 42 },
      problems: ["room is not a non-empty text or null"],
    },
    {
      case: "a room that is an empty string",
      act: "change" as Act,
      fields: { room: "" },
      problems: ["room is not a non-empty text or null"],
    },
    {
      case: "a teacher that is too long",
      act: "change" as Act,
      fields: { teacher: "x".repeat(maximumLessonTextLength + 1) },
      problems: ["teacher is not a non-empty text or null"],
    },
    {
      case: "an unknown field",
      act: "change" as Act,
      fields: { colour: "red" },
      problems: ["colour is not a field of this Item kind"],
    },
    {
      case: "multiple problems",
      act: "create" as Act,
      fields: { subject: "", span: "bad", room: 42, colour: "red" },
      problems: [
        "subject is not a non-empty text",
        "span is not a valid time span of a Lesson",
        "room is not a non-empty text or null",
        "colour is not a field of this Item kind",
      ],
    },
  ])("$case", ({ act, fields, problems }) => {
    expect(problemsWithLessonRevision(act, fields)).toEqual(problems);
  });

  it("does not report a problem for a null optional text field", () => {
    const problems = problemsWithLessonRevision("change", { room: null });
    expect(problems).not.toContain("room is not a non-empty text or null");
  });

  it("reports a problem for an empty previousRoom", () => {
    const problems = problemsWithTimetableChangeRevision("change", { previousRoom: "" });
    expect(problems).toContain("previousRoom is not a non-empty text or null");
  });

  it("rejects a null span", () => {
    const problems = problemsWithLessonRevision("create", { subject: "Math", span: null });
    expect(problems).toContain("span is not a valid time span of a Lesson");
  });

  it("rejects a span with a non-string end", () => {
    const problems = problemsWithLessonRevision("create", { subject: "Math", span: { allDay: false, start: "2026-09-15T14:00:00Z", end: 123 } });
    expect(problems).toContain("span is not a valid time span of a Lesson");
  });
});

describe("a Timetable Change Revision", () => {
  it.each([
    {
      case: "a create with all fields",
      act: "create" as Act,
      fields: { change: "cancellation", subject: "Math", span: span(), room: "202", teacher: "Mr. Jones", previousRoom: "201", previousTeacher: "Ms. Smith", note: "ill" },
      problems: [],
    },
    {
      case: "a create without a change",
      act: "create" as Act,
      fields: { subject: "Math", span: span() },
      problems: ["change is missing"],
    },
    {
      case: "a create without a subject",
      act: "create" as Act,
      fields: { change: "cancellation", span: span() },
      problems: ["subject is missing"],
    },
    {
      case: "a create without a span",
      act: "create" as Act,
      fields: { change: "cancellation", subject: "Math" },
      problems: ["span is missing"],
    },
    {
      case: "a move without a span",
      act: "move" as Act,
      fields: { change: "cancellation", subject: "Math" },
      problems: ["span is missing"],
    },
    {
      case: "a change with an invalid kind",
      act: "change" as Act,
      fields: { change: "holiday" },
      problems: [`change is not one of ${timetableChangeKinds.join(", ")}`],
    },
    {
      case: "a change with a valid kind",
      act: "change" as Act,
      fields: { change: "substitution" },
      problems: [],
    },
    {
      case: "a previousRoom that is not a string or null",
      act: "change" as Act,
      fields: { previousRoom: 42 },
      problems: ["previousRoom is not a non-empty text or null"],
    },
    {
      case: "a note that is too long",
      act: "change" as Act,
      fields: { note: "x".repeat(maximumLessonTextLength + 1) },
      problems: ["note is not a non-empty text or null"],
    },
    {
      case: "an unknown field",
      act: "change" as Act,
      fields: { colour: "red" },
      problems: ["colour is not a field of this Item kind"],
    },
  ])("$case", ({ act, fields, problems }) => {
    expect(problemsWithTimetableChangeRevision(act, fields)).toEqual(problems);
  });
});

describe("lessonOf", () => {
  it("returns the Lesson its Revisions describe", () => {
    const result = lessonOf(
      folded({ subject: "Math", span: span(), room: "201", teacher: "Ms. Smith" }, { cancelled: true }),
    );
    expect(result).toEqual({
      subject: "Math",
      span: { start: new Date("2026-09-15T08:00:00.000Z"), end: new Date("2026-09-15T09:00:00.000Z") },
      room: "201",
      teacher: "Ms. Smith",
      cancelled: true,
    });
  });

  it("returns null when there is no folded Item", () => {
    expect(lessonOf(null)).toBeNull();
  });

  it("returns null while it has no subject", () => {
    expect(lessonOf(folded({ span: span() }))).toBeNull();
  });

  it("returns null while it has no span", () => {
    expect(lessonOf(folded({ subject: "Math" }))).toBeNull();
  });

  it("returns null when the subject is empty", () => {
    expect(lessonOf(folded({ subject: "  ", span: span() }))).toBeNull();
  });

  it("returns null when the span is invalid", () => {
    expect(lessonOf(folded({ subject: "Math", span: "bad" }))).toBeNull();
  });

  it("returns null room and teacher when absent", () => {
    const result = lessonOf(folded({ subject: "Math", span: span() }));
    expect(result?.room).toBeNull();
    expect(result?.teacher).toBeNull();
  });
});

describe("timetableChangeOf", () => {
  it("returns the Timetable Change its Revisions describe", () => {
    const result = timetableChangeOf(
      folded({
        change: "room-change",
        subject: "Math",
        span: span(),
        room: "202",
        teacher: "Mr. Jones",
        previousRoom: "201",
        previousTeacher: "Ms. Smith",
        note: "ill",
      }, { cancelled: false }),
    );
    expect(result).toEqual({
      change: "room-change",
      subject: "Math",
      span: { start: new Date("2026-09-15T08:00:00.000Z"), end: new Date("2026-09-15T09:00:00.000Z") },
      room: "202",
      teacher: "Mr. Jones",
      previousRoom: "201",
      previousTeacher: "Ms. Smith",
      note: "ill",
      cancelled: false,
    });
  });

  it("returns null when there is no folded Item", () => {
    expect(timetableChangeOf(null)).toBeNull();
  });

  it("returns null when it has no change kind", () => {
    expect(timetableChangeOf(folded({ subject: "Math", span: span() }))).toBeNull();
  });

  it("returns null when the change kind is invalid", () => {
    expect(timetableChangeOf(folded({ change: "holiday", subject: "Math", span: span() }))).toBeNull();
  });

  it("returns null when the lesson part is missing", () => {
    expect(timetableChangeOf(folded({ change: "cancellation" }))).toBeNull();
  });
});
