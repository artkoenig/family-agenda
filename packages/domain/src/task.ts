import { isLocalDate, localDateTime, type LocalDate } from "./calendar";
import type { Act, FoldedItem } from "./item";

/**
 * Something to do or bring, by its Deadline if it has one. It is done from the instant someone
 * ticked it, and never by itself (decisions in #13). A cancelled Task stays where it shows,
 * struck through, pinned too until someone ticks it, so that the Family sees it was called off.
 */
export type Task = {
  title: string;
  deadline: LocalDate | null;
  /** The things to bring, as on a packing list; they are ticked with the Task, never one by one. */
  bring: string[];
  /** When it was ticked done; null while it is not. */
  doneAt: Date | null;
  cancelled: boolean;
};

/**
 * Where a Task stands on a day: `upcoming` before its Deadline day, `due` from then on, or at once
 * without a Deadline, `overdue` after its Deadline day, and `done` once ticked.
 */
export type TaskStatus = "upcoming" | "due" | "overdue" | "done";

export const maximumTaskTextLength = 500;

/** At most how many things to bring a Task lists. */
export const maximumThingsToBring = 50;

/**
 * The fields of a Task Revision, as a Source states them in JSON: `title` (text), `deadline`
 * (`YYYY-MM-DD` or null) and `bring` (a list of texts). `done` (an ISO instant, or null) is
 * stated only by ticking the Task, never by a Source.
 */
const taskFields = ["title", "deadline", "bring"] as const;

/** Why a Task Revision from a Source cannot be applied; none if it can. */
export function problemsWithTaskRevision(act: Act, fields: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (act === "create" && !("title" in fields)) problems.push("title is missing");
  if (act === "move" && !("deadline" in fields)) problems.push("deadline is missing");
  if ("title" in fields && parseText(fields.title) === null) problems.push("title is not a non-empty text");
  if ("deadline" in fields && fields.deadline !== null && parseDeadline(fields.deadline) === null) {
    problems.push("deadline is not a date or null");
  }
  if ("bring" in fields && parseBring(fields.bring) === null) {
    problems.push(`bring is not a list of at most ${maximumThingsToBring} non-empty texts`);
  }
  for (const key of Object.keys(fields)) {
    if (!(taskFields as readonly string[]).includes(key)) problems.push(`${key} is not a field of a Task`);
  }
  return problems;
}

/** The fields of a Revision that ticks a Task done at `at`, or takes the tick back. */
export function tickFields(done: boolean, at: Date): Record<string, unknown> {
  return { done: done ? at.toISOString() : null };
}

/** The Task its folded Revisions describe, or null while it has no title yet. */
export function taskOf(folded: FoldedItem | null): Task | null {
  if (!folded) return null;
  const title = parseText(folded.fields.title);
  if (title === null) return null;
  const doneAt = typeof folded.fields.done === "string" ? new Date(folded.fields.done) : null;
  return {
    title,
    deadline: parseDeadline(folded.fields.deadline),
    bring: parseBring(folded.fields.bring) ?? [],
    doneAt: doneAt && !Number.isNaN(doneAt.getTime()) ? doneAt : null,
    cancelled: folded.cancelled,
  };
}

/** Where the Task stands on the Family's day `today`. */
export function taskStatus(task: Task, today: LocalDate): TaskStatus {
  if (task.doneAt) return "done";
  if (task.deadline === null || task.deadline === today) return "due";
  return task.deadline < today ? "overdue" : "upcoming";
}

/**
 * Whether the Task is pinned at the top of a View on `today`: from when it is Due until someone
 * ticks it, cancelled or not.
 */
export function isPinned(task: Task, today: LocalDate): boolean {
  const status = taskStatus(task, today);
  return status === "due" || status === "overdue";
}

/**
 * The day of the Family a Task shows on when it is not pinned: its Deadline day, or the day it was
 * ticked if it has no Deadline; null if it has neither.
 */
export function dayOfTask(task: Task, timeZone: string): LocalDate | null {
  return task.deadline ?? (task.doneAt ? localDateTime(task.doneAt, timeZone).date : null);
}

/**
 * Whether the Task waits for someone to tick it, whatever its date: it is not done. A store
 * finds these apart from their time, as a Task without a Deadline has none.
 */
export function isOutstanding(task: Task): boolean {
  return !task.doneAt;
}

function parseText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text !== "" && text.length <= maximumTaskTextLength ? text : null;
}

function parseDeadline(value: unknown): LocalDate | null {
  return typeof value === "string" && isLocalDate(value) ? value : null;
}

function parseBring(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > maximumThingsToBring) return null;
  const things = value.map(parseText);
  return things.every((thing) => thing !== null) ? things : null;
}
