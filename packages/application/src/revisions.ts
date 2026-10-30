import {
  eventOf,
  fold,
  lessonOf,
  problemsWithEventRevision,
  problemsWithLessonRevision,
  problemsWithTaskRevision,
  problemsWithTimetableChangeRevision,
  spanBounds,
  instantOfTask,
  isOutstanding,
  taskOf,
  type Act,
  type FoldableRevision,
  type ItemKind,
  type LocalDate,
} from "@family-agenda/domain";
import type { IngestedRevision, ItemProjection, NewRevision } from "./ports";

/** Why a Revision of an Item kind cannot be applied, for the kinds whose fields are defined yet. */
const problemsByKind: Partial<Record<ItemKind, (act: Act, fields: Record<string, unknown>) => string[]>> = {
  event: problemsWithEventRevision,
  lesson: problemsWithLessonRevision,
  "timetable-change": problemsWithTimetableChangeRevision,
  task: problemsWithTaskRevision,
};

/**
 * A Revision as it is appended: rejected automatically if its fields cannot apply. Notices have
 * no fields defined yet; they come with their own ticket.
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
    return { folded, window: event ? spanBounds(event.span) : null, outstanding: false };
  }
  if (kind === "task") {
    const arrivedAt = revisions.filter((revision) => revision.accepted).reduce<Date | null>(
      (earliest, { sourceTime }) => (earliest && earliest <= sourceTime ? earliest : sourceTime),
      null,
    );
    const stated = folded && arrivedAt ? { ...folded, arrivedAt: arrivedAt.toISOString() } : folded;
    const task = taskOf(stated);
    // Without a Deadline, a done Task shows on the day it arrived, whatever the time zone.
    const day = task?.deadline ?? (task && instantOfTask(task))?.toISOString().slice(0, 10);
    const window = day ? spanBounds({ allDay: true, firstDay: day as LocalDate, lastDay: day as LocalDate }) : null;
    return { folded: stated, window, outstanding: task ? isOutstanding(task) : false };
  }
  // A Timetable Change has the fields of the Lesson it changes, its span among them.
  const lesson = kind === "lesson" || kind === "timetable-change" ? lessonOf(folded) : null;
  return { folded, window: lesson ? { from: lesson.span.start, to: lesson.span.end } : null, outstanding: false };
}
