import { isLocalDate, localDateTime, type LocalDate } from "./calendar";
import type { ItemFields } from "./item";

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
  /** When it was first stated, such as when the message that names it was sent; null if unknown. */
  arrivedAt: Date | null;
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
 * The fields of a Task, as a Source or extraction states them in JSON: `title` (text), `deadline`
 * (`YYYY-MM-DD` or null) and `bring` (a list of texts). Whether it is done is only ever set by
 * ticking it.
 */
const taskFields = ["title", "deadline", "bring"] as const;

/** Why the fields describe no Task; none if they do. */
export function problemsWithTaskFields(fields: Record<string, unknown>): string[] {
  return [...missingProblems(fields), ...fieldProblems(fields), ...unknownFieldProblems(fields, taskFields)];
}

function missingProblems(fields: Record<string, unknown>): string[] {
  return "title" in fields ? [] : ["title is missing"];
}

function fieldProblems(fields: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if ("title" in fields && parseText(fields.title) === null) problems.push("title is not a non-empty text");
  if ("deadline" in fields && fields.deadline !== null && parseDeadline(fields.deadline) === null) {
    problems.push("deadline is not a date or null");
  }
  if ("bring" in fields && parseBring(fields.bring) === null) {
    problems.push(`bring is not a list of at most ${maximumThingsToBring} non-empty texts`);
  }
  return problems;
}

function unknownFieldProblems(fields: Record<string, unknown>, known: readonly string[]): string[] {
  return Object.keys(fields)
    .filter((key) => !known.includes(key))
    .map((key) => `${key} is not a field of a Task`);
}

/** What a Source or a message states about a Task; whether it is done is up to the Family. */
export type StatedTask = Pick<Task, "title" | "deadline" | "bring" | "cancelled">;

/** The Task its fields describe, or null while it has no title yet. */
export function taskOf(folded: ItemFields | null): StatedTask | null {
  if (!folded) return null;
  const title = parseText(folded.fields.title);
  if (title === null) return null;
  return {
    title,
    deadline: parseDeadline(folded.fields.deadline),
    bring: parseBring(folded.fields.bring) ?? [],
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
 * Whether the Task is pinned at the top of an Agenda on `today`: from when it is Due until someone
 * ticks it, cancelled or not.
 */
export function isPinned(task: Task, today: LocalDate): boolean {
  const status = taskStatus(task, today);
  return status === "due" || status === "overdue";
}

/**
 * The instant whose day a done Task without a Deadline shows on: when it was first stated, not
 * when it was ticked, as what it asks of the Family belongs to that message. Null while it is not
 * done or has a Deadline. A Task whose arrival is unknown falls back to its tick.
 */
export function instantOfTask(task: Task): Date | null {
  return task.deadline === null && task.doneAt ? (task.arrivedAt ?? task.doneAt) : null;
}

/**
 * The day of the Family a Task shows on when it is not pinned: its Deadline day, or the day it
 * arrived if it has no Deadline and is done; null if it is neither.
 */
export function dayOfTask(task: Task, timeZone: string): LocalDate | null {
  const instant = instantOfTask(task);
  return task.deadline ?? (instant ? localDateTime(instant, timeZone).date : null);
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
