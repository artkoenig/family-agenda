import { describe, expect, it } from "vitest";
import {
  lessonOf,
  maximumLessonTextLength,
  problemsWithLessonFields,
  timetableChangeKinds,
  timetableChangeOf,
  type ItemFields,
} from "../src";

const span = (start = "2026-09-15T08:00:00.000Z", end = "2026-09-15T09:00:00.000Z") => ({
  allDay: false,
  start,
  end,
});

const folded = (fields: Record<string, unknown>, more: Partial<ItemFields> = {}): ItemFields => ({
  fields,
  cancelled: false,
  ...more,
});

/** The problems of fields that state only some of a Lesson as planned, the rest being fine. */
const completed = (fields: Record<string, unknown>) => problemsWithLessonFields({ subject: "Math", span: span(), ...fields });

/** The problems of fields that state only some of a changed Lesson, the rest being fine. */
const changed = (fields: Record<string, unknown>) => completed({ change: "substitution", ...fields });

describe("a Lesson's fields", () => {
  it.each([
    {
      case: "fields with all fields",
      fields: { subject: "Math", span: span(), room: "201", teacher: "Ms. Smith" },
      problems: [],
    },
    {
      case: "fields without a subject",
      fields: { span: span() },
      problems: ["subject is missing"],
    },
    {
      case: "fields without a span",
      fields: { subject: "Math" },
      problems: ["span is missing"],
    },
    {
      case: "fields with an empty subject",
      partial: true,
      fields: { subject: "   " },
      problems: ["subject is not a non-empty text"],
    },
    {
      case: "a subject that is too long",
      partial: true,
      fields: { subject: "x".repeat(maximumLessonTextLength + 1) },
      problems: ["subject is not a non-empty text"],
    },
    {
      case: "a subject at the maximum length",
      partial: true,
      fields: { subject: "x".repeat(maximumLessonTextLength) },
      problems: [],
    },
    {
      case: "a subject that is not a string",
      partial: true,
      fields: { subject: 42 },
      problems: ["subject is not a non-empty text"],
    },
    {
      case: "a span that is not an object",
      partial: true,
      fields: { span: "2026-09-15T08:00:00.000Z" },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with allDay true",
      partial: true,
      fields: { span: { allDay: true, firstDay: "2026-09-15", lastDay: "2026-09-15" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with allDay not false",
      partial: true,
      fields: { span: { allDay: undefined, start: "2026-09-15T08:00:00.000Z", end: "2026-09-15T09:00:00.000Z" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with a non-string start",
      partial: true,
      fields: { span: { allDay: false, start: 123, end: "2026-09-15T09:00:00.000Z" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with a non-string end",
      partial: true,
      fields: { span: { allDay: false, start: "2026-09-15T08:00:00.000Z", end: 123 } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with an invalid start date",
      partial: true,
      fields: { span: { allDay: false, start: "not-a-date", end: "2026-09-15T09:00:00.000Z" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span with an invalid end date",
      partial: true,
      fields: { span: { allDay: false, start: "2026-09-15T08:00:00.000Z", end: "not-a-date" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span where end equals start",
      partial: true,
      fields: { span: { allDay: false, start: "2026-09-15T08:00:00.000Z", end: "2026-09-15T08:00:00.000Z" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a span where end is before start",
      partial: true,
      fields: { span: { allDay: false, start: "2026-09-15T09:00:00.000Z", end: "2026-09-15T08:00:00.000Z" } },
      problems: ["span is not a valid time span of a Lesson"],
    },
    {
      case: "a room that is not a string or null",
      partial: true,
      fields: { room: 42 },
      problems: ["room is not a non-empty text or null"],
    },
    {
      case: "a room that is an empty string",
      partial: true,
      fields: { room: "" },
      problems: ["room is not a non-empty text or null"],
    },
    {
      case: "a teacher that is too long",
      partial: true,
      fields: { teacher: "x".repeat(maximumLessonTextLength + 1) },
      problems: ["teacher is not a non-empty text or null"],
    },
    {
      case: "an unknown field",
      partial: true,
      fields: { colour: "red" },
      problems: ["colour is not a field of this Item kind"],
    },
    {
      case: "multiple problems",
      fields: { subject: "", span: "bad", room: 42, colour: "red" },
      problems: [
        "subject is not a non-empty text",
        "span is not a valid time span of a Lesson",
        "room is not a non-empty text or null",
        "colour is not a field of this Item kind",
      ],
    },
  ])("$case", ({ partial, fields, problems }) => {
    expect(partial ? completed(fields) : problemsWithLessonFields(fields)).toEqual(problems);
  });

  it("does not report a problem for a null optional text field", () => {
    const problems = completed({ room: null });
    expect(problems).not.toContain("room is not a non-empty text or null");
  });

  it("reports a problem for an empty previousRoom", () => {
    const problems = changed({ previousRoom: "" });
    expect(problems).toContain("previousRoom is not a non-empty text or null");
  });

  it("rejects a null span", () => {
    const problems = problemsWithLessonFields({ subject: "Math", span: null });
    expect(problems).toContain("span is not a valid time span of a Lesson");
  });

  it("rejects a span with a non-string end", () => {
    const problems = problemsWithLessonFields({ subject: "Math", span: { allDay: false, start: "2026-09-15T14:00:00Z", end: 123 } });
    expect(problems).toContain("span is not a valid time span of a Lesson");
  });
});

describe("a changed Lesson's fields", () => {
  it.each([
    {
      case: "fields with all fields",
      fields: { change: "cancellation", subject: "Math", span: span(), room: "202", teacher: "Mr. Jones", previousRoom: "201", previousTeacher: "Ms. Smith", note: "ill" },
      problems: [],
    },
    {
      case: "fields without a subject",
      fields: { change: "cancellation", span: span() },
      problems: ["subject is missing"],
    },
    {
      case: "fields without a span",
      fields: { change: "cancellation", subject: "Math" },
      problems: ["span is missing"],
    },
    {
      case: "fields with an invalid kind",
      partial: true,
      fields: { change: "holiday" },
      problems: [`change is not one of ${timetableChangeKinds.join(", ")}, or null`],
    },
    {
      case: "fields with a valid kind",
      partial: true,
      fields: { change: "substitution" },
      problems: [],
    },
    {
      case: "a previousRoom that is not a string or null",
      partial: true,
      fields: { previousRoom: 42 },
      problems: ["previousRoom is not a non-empty text or null"],
    },
    {
      case: "a note that is too long",
      partial: true,
      fields: { note: "x".repeat(maximumLessonTextLength + 1) },
      problems: ["note is not a non-empty text or null"],
    },
    {
      case: "an unknown field",
      partial: true,
      fields: { colour: "red" },
      problems: ["colour is not a field of this Item kind"],
    },
  ])("$case", ({ partial, fields, problems }) => {
    expect(partial ? changed(fields) : problemsWithLessonFields(fields)).toEqual(problems);
  });
});

describe("lessonOf", () => {
  it("returns the Lesson its fields describe", () => {
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
  it("returns the Timetable Change its fields describe", () => {
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
