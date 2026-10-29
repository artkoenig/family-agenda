import {
  eventOf,
  fold,
  lessonOf,
  problemsWithEventRevision,
  problemsWithLessonRevision,
  problemsWithTimetableChangeRevision,
  spanBounds,
  type Act,
  type FoldableRevision,
  type ItemKind,
} from "@family-agenda/domain";
import type { IngestedRevision, ItemProjection, NewRevision } from "./ports";

/** Why a Revision of an Item kind cannot be applied, for the kinds whose fields are defined yet. */
const problemsByKind: Partial<Record<ItemKind, (act: Act, fields: Record<string, unknown>) => string[]>> = {
  event: problemsWithEventRevision,
  lesson: problemsWithLessonRevision,
  "timetable-change": problemsWithTimetableChangeRevision,
};

/**
 * A Revision as it is appended: rejected automatically if its fields cannot apply. Tasks and
 * Notices have no fields defined yet; they come with their own tickets.
 */
export function checked(revision: IngestedRevision, sourceTime: Date): NewRevision {
  const problems = problemsByKind[revision.itemKind];
  const accepted = !problems || problems(revision.act, revision.fields).length === 0;
  return { ...revision, sourceTime, accepted, rejection: accepted ? null : "invalid-fields", evidence: null };
}

/** What an Item's Revisions add up to, and the time it can be found by. */
export function project(kind: ItemKind, revisions: FoldableRevision[]): ItemProjection {
  const folded = fold(revisions);
  if (kind === "event") {
    const event = eventOf(folded);
    return { folded, window: event ? spanBounds(event.span) : null };
  }
  // A Timetable Change has the fields of the Lesson it changes, its span among them.
  const lesson = kind === "lesson" || kind === "timetable-change" ? lessonOf(folded) : null;
  return { folded, window: lesson ? { from: lesson.span.start, to: lesson.span.end } : null };
}
