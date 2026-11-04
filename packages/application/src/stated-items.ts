import { eventOf, lessonOf, problemsWithEventFields, problemsWithLessonFields, timetableChangeOf } from "@family-agenda/domain";
import type { ReadStated, StatedJson } from "./ports";

/**
 * The Item a calendar or timetable entry states (ADR-0016), checked as its kind requires: an Event
 * with `cancelled` as its Source says, or a Lesson with its Timetable Change. One that is invalid
 * is no Item, and says why.
 */
export const readStated: ReadStated = (stated) => {
  const { kind, ...fields } = stated;
  if (kind === "event") return eventFrom(fields);
  if (kind === "lesson") return lessonFrom(fields);
  return { ok: false, problems: [`"${String(kind)}" is no kind of Item a Source states`] };
};

function eventFrom(stated: StatedJson): ReturnType<ReadStated> {
  const { cancelled = false, ...fields } = stated;
  const problems = problemsWithEventFields(fields);
  if (typeof cancelled !== "boolean") problems.push("cancelled is not true or false");
  const event = problems.length === 0 ? eventOf({ fields, cancelled: cancelled as boolean }) : null;
  return event ? { ok: true, item: { kind: "event", event } } : { ok: false, problems };
}

function lessonFrom(fields: StatedJson): ReturnType<ReadStated> {
  const problems = problemsWithLessonFields(fields);
  const lesson = problems.length === 0 ? lessonOf({ fields, cancelled: false }) : null;
  if (!lesson) return { ok: false, problems };
  const { subject, span, room, teacher } = lesson;
  const change = timetableChangeOf({ fields, cancelled: false });
  return {
    ok: true,
    item: {
      kind: "lesson",
      lesson: { subject, span, room, teacher },
      change: change && { change: change.change, previousRoom: change.previousRoom, previousTeacher: change.previousTeacher, note: change.note },
    },
  };
}
