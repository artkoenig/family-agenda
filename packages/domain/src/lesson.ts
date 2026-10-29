import type { Act, FoldedItem } from "./item";

/** When a Lesson takes place: from one instant to another, never all day. */
export type LessonSpan = { start: Date; end: Date };

/** One slot of a Timetable, as it takes place: its subject, time, room and teacher. */
export type Lesson = { subject: string; span: LessonSpan; room: string | null; teacher: string | null; cancelled: boolean };

export const timetableChangeKinds = ["cancellation", "substitution", "room-change"] as const;

export type TimetableChangeKind = (typeof timetableChangeKinds)[number];

/**
 * A deviation from the Timetable on one date: a Lesson cancelled, taught by a substitute, or moved
 * to another room. `room` and `teacher` are those the Lesson has now, `previousRoom` and
 * `previousTeacher` those it had; `note` is what the school wrote about it. A cancelled Timetable
 * Change is one the school withdrew.
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
  cancelled: boolean;
};

export const maximumLessonTextLength = 200;

/**
 * The fields of a Lesson Revision, as a Source states them in JSON: `subject` (text), `span`
 * (`{ allDay: false, start, end }` with ISO instants), and `room` and `teacher` (text or null).
 */
const lessonFields = ["subject", "span", "room", "teacher"] as const;

/**
 * The fields of a Timetable Change Revision: those of a Lesson, `change` (one of
 * `timetableChangeKinds`), and `previousRoom`, `previousTeacher` and `note` (text or null).
 */
const timetableChangeFields = [...lessonFields, "change", "previousRoom", "previousTeacher", "note"] as const;

const optionalTexts = ["room", "teacher", "previousRoom", "previousTeacher", "note"];

/** Why a Lesson Revision cannot be applied; none if it can. */
export function problemsWithLessonRevision(act: Act, fields: Record<string, unknown>): string[] {
  return problemsWith(act, fields, lessonFields, ["subject", "span"]);
}

/** Why a Timetable Change Revision cannot be applied; none if it can. */
export function problemsWithTimetableChangeRevision(act: Act, fields: Record<string, unknown>): string[] {
  const problems = problemsWith(act, fields, timetableChangeFields, ["change", "subject", "span"]);
  if ("change" in fields && parseChange(fields.change) === null) {
    problems.push(`change is not one of ${timetableChangeKinds.join(", ")}`);
  }
  return problems;
}

function problemsWith(act: Act, fields: Record<string, unknown>, known: readonly string[], created: string[]): string[] {
  const problems: string[] = [];
  const required = act === "create" ? created : act === "move" ? ["span"] : [];
  for (const key of required) if (!(key in fields)) problems.push(`${key} is missing`);
  if ("subject" in fields && parseText(fields.subject) === null) problems.push("subject is not a non-empty text");
  if ("span" in fields && parseSpan(fields.span) === null) problems.push("span is not a valid time span of a Lesson");
  for (const key of optionalTexts) {
    if (key in fields && fields[key] !== null && parseText(fields[key]) === null) problems.push(`${key} is not a non-empty text or null`);
  }
  for (const key of Object.keys(fields)) if (!known.includes(key)) problems.push(`${key} is not a field of this Item kind`);
  return problems;
}

/** The Lesson its folded Revisions describe, or null while it has no subject or span yet. */
export function lessonOf(folded: FoldedItem | null): Lesson | null {
  if (!folded) return null;
  const subject = parseText(folded.fields.subject);
  const span = parseSpan(folded.fields.span);
  if (subject === null || span === null) return null;
  const { room, teacher } = folded.fields;
  return { subject, span, room: parseText(room), teacher: parseText(teacher), cancelled: folded.cancelled };
}

/** The Timetable Change its folded Revisions describe, or null while it lacks its kind, subject or span. */
export function timetableChangeOf(folded: FoldedItem | null): TimetableChange | null {
  const lesson = lessonOf(folded);
  const change = parseChange(folded?.fields.change);
  if (!folded || !lesson || !change) return null;
  const { previousRoom, previousTeacher, note } = folded.fields;
  return {
    ...lesson,
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
  const start = new Date(span.start);
  const end = new Date(span.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return { start, end };
}
