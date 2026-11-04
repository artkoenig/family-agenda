import {
  eventOf,
  lessonOf,
  problemsWithEventRevision,
  problemsWithLessonRevision,
  problemsWithTaskRevision,
  problemsWithTimetableChangeRevision,
  taskOf,
  timetableChangeOf,
  type Act,
  type ItemFields,
  type ItemKind,
} from "@family-agenda/domain";
import type { ApplyRevisions, IngestedRevision, PluginItemKind, StatedItem, StoredChange } from "./ports";

/**
 * Until calendars and timetables state their Items on the Source Record (#137), the core works out
 * an entry's one Item from the Revisions its plugin states: each applies to what the Item was, the
 * newest last. A Timetable Change is stored on its Lesson; a Notice is not kept.
 */
export const applyRevisions: ApplyRevisions = (current, revisions) => {
  const kind = current ? current.kind : kindOf(revisions);
  if (!kind) return current;
  const stated = revisions.filter((revision) => itemKindOf(revision.itemKind) === kind && applies(revision)).reduce(applied, current && fieldsOf(current));
  return stated && itemOf(kind, stated);
};

/** The kind of Item a plugin's Revisions are about. */
function itemKindOf(kind: PluginItemKind): ItemKind | null {
  if (kind === "timetable-change") return "lesson";
  return kind === "notice" ? null : kind;
}

/** The kind of Item an entry's first Revision of a kept kind is about. */
function kindOf(revisions: IngestedRevision[]): ItemKind | null {
  return revisions.map((revision) => itemKindOf(revision.itemKind)).find((kind) => kind !== null) ?? null;
}

/** Why a Revision of a plugin's Item kind cannot be applied. */
const problemsByKind: Record<Exclude<PluginItemKind, "notice">, (act: Act, fields: Record<string, unknown>) => string[]> = {
  event: problemsWithEventRevision,
  lesson: problemsWithLessonRevision,
  "timetable-change": problemsWithTimetableChangeRevision,
  task: problemsWithTaskRevision,
};

/** Whether the Revision's fields can apply; one that cannot is left out. A Notice is never kept. */
function applies(revision: IngestedRevision): boolean {
  return revision.itemKind !== "notice" && problemsByKind[revision.itemKind](revision.act, revision.fields).length === 0;
}

/** The fields of a Timetable Change that a Lesson does not have itself. */
const changeFields = ["change", "previousRoom", "previousTeacher", "note"];

/** The fields without a Lesson's Timetable Change. */
function withoutChange(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !changeFields.includes(key)));
}

/** The fields after one Revision, starting from nothing for an entry not known yet. */
function applied(stated: ItemFields | null, revision: IngestedRevision): ItemFields {
  const current = stated ?? { fields: {}, cancelled: false };
  return revision.itemKind === "timetable-change" ? appliedChange(current, revision) : appliedStatement(current, revision);
}

/**
 * A Timetable Change applied to its Lesson; one the school withdrew leaves the Lesson as planned.
 * What the Lesson has now, its subject, room and teacher, the Lesson's own Revisions state.
 */
function appliedChange(stated: ItemFields, revision: IngestedRevision): ItemFields {
  if (revision.act === "cancel") return { fields: withoutChange(stated.fields), cancelled: stated.cancelled };
  const change = Object.fromEntries(Object.entries(revision.fields).filter(([key]) => changeFields.includes(key)));
  return { fields: { ...stated.fields, ...change }, cancelled: stated.cancelled };
}

/** A create restores a cancelled Item, a cancel calls it off; a Lesson taking place again loses its cancellation. */
function appliedStatement(stated: ItemFields, revision: IngestedRevision): ItemFields {
  const restored = revision.act === "create" && stated.fields.change === "cancellation" ? withoutChange(stated.fields) : stated.fields;
  const fields = { ...restored, ...revision.fields };
  if (revision.act === "cancel") return { fields, cancelled: true };
  return { fields, cancelled: revision.act !== "create" && stated.cancelled };
}

/** The Item as the fields a plugin states. */
function fieldsOf(item: StatedItem): ItemFields {
  if (item.kind === "event") {
    const { title, span, place, cancelled } = item.event;
    return { fields: { title, span: span.allDay ? span : timedJson(span), place }, cancelled };
  }
  if (item.kind === "task") {
    const { title, deadline, bring, cancelled } = item.task;
    return { fields: { title, deadline, bring }, cancelled };
  }
  const { subject, span, room, teacher } = item.lesson;
  const change = item.change ?? {};
  return { fields: { subject, span: timedJson(span), room, teacher, ...change }, cancelled: item.change?.change === "cancellation" };
}

/** A span between two instants, as a plugin states it in JSON. */
function timedJson(span: { start: Date; end: Date }) {
  return { allDay: false, start: span.start.toISOString(), end: span.end.toISOString() };
}

/** The Item the fields describe, or null while they lack what its kind needs. */
function itemOf(kind: ItemKind, stated: ItemFields): StatedItem | null {
  if (kind === "event") {
    const event = eventOf(stated);
    return event && { kind, event };
  }
  if (kind === "task") {
    const task = taskOf(stated);
    return task && { kind, task };
  }
  return lessonItemOf(stated);
}

const cancellation: StoredChange = { change: "cancellation", previousRoom: null, previousTeacher: null, note: null };

/** The Lesson with its Timetable Change; one the plugin cancelled without a Timetable Change is stored as one. */
function lessonItemOf(stated: ItemFields): StatedItem | null {
  const lesson = lessonOf(stated);
  if (!lesson) return null;
  const { subject, span, room, teacher } = lesson;
  const change = timetableChangeOf(stated);
  const stored = change && { change: change.change, previousRoom: change.previousRoom, previousTeacher: change.previousTeacher, note: change.note };
  return { kind: "lesson", lesson: { subject, span, room, teacher }, change: stored ?? (lesson.cancelled ? cancellation : null) };
}
