import type { ItemFields } from "./item";

/** When a Lesson takes place: from one instant to another, never all day. */
export type LessonSpan = { start: Date; end: Date };

/** One slot of a Timetable, as it takes place: its subject, time, room and teacher. */
export type Lesson = { subject: string; span: LessonSpan; room: string | null; teacher: string | null; cancelled: boolean };

export const timetableChangeKinds = ["cancellation", "substitution", "room-change"] as const;

export type TimetableChangeKind = (typeof timetableChangeKinds)[number];

/**
 * A deviation from the Timetable on one date: a Lesson cancelled, taught by a substitute, or moved
 * to another room. `room` and `teacher` are those the Lesson has now, `previousRoom` and
 * `previousTeacher` those it had; `note` is what the school wrote about it. It is stored on its
 * Lesson.
 */
export type TimetableChange = {
  change: TimetableChangeKind;
  subject: string;
  span: LessonSpan;
  room: string | null;
  teacher: string | null;
  previousRoom: string | null;
  previousTeacher: string | null;
  note: string | null;
};

export const maximumLessonTextLength = 200;

/**
 * The fields of a Lesson, as a Source states them in JSON: `subject` (text), `span`
 * (`{ allDay: false, start, end }` with ISO instants), `room` and `teacher` (text or null), and its
 * Timetable Change: `change` (one of `timetableChangeKinds`, or null as planned), with
 * `previousRoom`, `previousTeacher` and `note` (text or null), which only a change has.
 */
const lessonFields = ["subject", "span", "room", "teacher", "change", "previousRoom", "previousTeacher", "note"] as const;

const optionalTexts = ["room", "teacher", "previousRoom", "previousTeacher", "note"];

/** What only a Lesson with a Timetable Change has. */
const changeDetails = ["previousRoom", "previousTeacher", "note"];

/** Why the fields describe no Lesson; none if they do. */
export function problemsWithLessonFields(fields: Record<string, unknown>): string[] {
  const problems = ["subject", "span"].filter((key) => !(key in fields)).map((key) => `${key} is missing`);
  problems.push(...fieldTextProblems(fields), ...changeProblems(fields), ...unknownFieldProblems(fields, lessonFields));
  return problems;
}

function changeProblems(fields: Record<string, unknown>): string[] {
  const change = fields.change ?? null;
  if (change !== null && parseChange(change) === null) return [`change is not one of ${timetableChangeKinds.join(", ")}, or null`];
  if (change !== null) return [];
  return changeDetails.filter((key) => (fields[key] ?? null) !== null).map((key) => `${key} needs a change`);
}

function fieldTextProblems(fields: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if ("subject" in fields && parseText(fields.subject) === null) problems.push("subject is not a non-empty text");
  if ("span" in fields && parseSpan(fields.span) === null) problems.push("span is not a valid time span of a Lesson");
  return [...problems, ...optionalTextProblems(fields)];
}

function optionalTextProblems(fields: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of optionalTexts) {
    if (key in fields && fields[key] !== null && parseText(fields[key]) === null) problems.push(`${key} is not a non-empty text or null`);
  }
  return problems;
}

function unknownFieldProblems(fields: Record<string, unknown>, known: readonly string[]): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(fields)) if (!known.includes(key)) problems.push(`${key} is not a field of this Item kind`);
  return problems;
}

/** The Lesson its fields describe, or null while it has no subject or span yet. */
export function lessonOf(folded: ItemFields | null): Lesson | null {
  if (!folded) return null;
  const subject = parseText(folded.fields.subject);
  const span = parseSpan(folded.fields.span);
  if (subject === null || span === null) return null;
  const { room, teacher } = folded.fields;
  return { subject, span, room: parseText(room), teacher: parseText(teacher), cancelled: folded.cancelled };
}

/** The Timetable Change its fields describe, or null while it lacks its kind, subject or span. */
export function timetableChangeOf(folded: ItemFields | null): TimetableChange | null {
  const lesson = lessonOf(folded);
  const change = parseChange(folded?.fields.change);
  if (!folded || !lesson || !change) return null;
  const { previousRoom, previousTeacher, note } = folded.fields;
  return {
    subject: lesson.subject,
    span: lesson.span,
    room: lesson.room,
    teacher: lesson.teacher,
    change,
    previousRoom: parseText(previousRoom),
    previousTeacher: parseText(previousTeacher),
    note: parseText(note),
  };
}

function parseChange(value: unknown): TimetableChangeKind | null {
  return (timetableChangeKinds as readonly unknown[]).includes(value) ? (value as TimetableChangeKind) : null;
}

function parseText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text !== "" && text.length <= maximumLessonTextLength ? text : null;
}

function parseSpan(value: unknown): LessonSpan | null {
  if (typeof value !== "object" || value === null) return null;
  const span = value as Record<string, unknown>;
  if (span.allDay !== false || typeof span.start !== "string" || typeof span.end !== "string") return null;
  return validSpan(span.start, span.end);
}

function validSpan(startText: string, endText: string): LessonSpan | null {
  const start = new Date(startText);
  const end = new Date(endText);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return { start, end };
}
