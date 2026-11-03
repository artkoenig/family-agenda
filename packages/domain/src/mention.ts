import { addDays, localDateTime, type LocalDate } from "./calendar";

export const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

export type Weekday = (typeof weekdays)[number];

/**
 * A date as a message words it, left for code to resolve against the day the message was sent,
 * so that no model has to count days. Every part is null when the message does not state it.
 */
export type DateMention = {
  day: number | null;
  month: number | null;
  /** As written: four digits, or two for this century. */
  year: number | null;
  weekday: Weekday | null;
  /** Days after the day it was sent, as for "today" (0), "tomorrow" (1) or "in two weeks" (14). */
  daysAfter: number | null;
  /** With a weekday alone: weeks after the week it was sent in, as for "next week on Tuesday" (1). */
  weeksAfter: number | null;
};

export type ResolvedDate =
  | { ok: true; date: LocalDate }
  /** The date the day and month or count of days state, which the weekday does not fall on. */
  | { ok: false; problem: "weekday-mismatch"; date: LocalDate }
  | { ok: false; problem: "no-date" };

/** How far back a date without a year may lie before it is taken to be next year's. */
const daysBackWithoutYear = 60;

/**
 * The date a mention means, for a message sent on `sentOn`. A day and month win over a count of
 * days, which wins over a weekday alone; a weekday stated next to a date has to match it. A
 * weekday alone is its next occurrence after the day the message was sent.
 */
export function resolveDate(mention: DateMention, sentOn: LocalDate): ResolvedDate {
  const { day, month, year, weekday, daysAfter, weeksAfter } = mention;
  // A day without its month could be any month's, whatever weekday it is said to be.
  if (day !== null) return explicitMention(year, month, day, sentOn, weekday);
  if (daysAfter !== null && Number.isInteger(daysAfter)) return checkWeekday(addDays(sentOn, daysAfter), weekday);
  if (weekday !== null) return weekdayDate(weekday, weeksAfter, sentOn);
  return { ok: false, problem: "no-date" };
}

function explicitMention(
  year: number | null,
  month: number | null,
  day: number,
  sentOn: LocalDate,
  weekday: Weekday | null,
): ResolvedDate {
  if (month === null) return { ok: false, problem: "no-date" };
  const date = explicitDate(year, month, day, sentOn);
  if (date === null) return { ok: false, problem: "no-date" };
  return checkWeekday(date, weekday);
}

/** Whether a resolved date falls on the weekday the message stated, if any. */
function checkWeekday(date: LocalDate, weekday: Weekday | null): ResolvedDate {
  if (weekday !== null && weekdayOf(date) !== weekday) return { ok: false, problem: "weekday-mismatch", date };
  return { ok: true, date };
}

/** The date a day and month state, resolving a missing or two-digit year against `sentOn`. */
function explicitDate(year: number | null, month: number, day: number, sentOn: LocalDate): LocalDate | null {
  if (year !== null) return dateOf(year < 100 ? 2000 + year : year, month, day);
  const thisYear = Number(sentOn.slice(0, 4));
  const candidate = dateOf(thisYear, month, day);
  return candidate && candidate < addDays(sentOn, -daysBackWithoutYear) ? dateOf(thisYear + 1, month, day) : candidate;
}

/** The date a weekday alone states: next occurrence, or the one `weeksAfter` weeks ahead. */
function weekdayDate(weekday: Weekday, weeksAfter: number | null, sentOn: LocalDate): ResolvedDate {
  const wanted = weekdays.indexOf(weekday);
  if (weeksAfter !== null && Number.isInteger(weeksAfter)) {
    const monday = addDays(sentOn, -weekdayIndex(sentOn));
    return { ok: true, date: addDays(monday, 7 * weeksAfter + wanted) };
  }
  return { ok: true, date: addDays(sentOn, ((wanted - weekdayIndex(sentOn) + 6) % 7) + 1) };
}

/**
 * The Deadline a mention means, for a message sent on `sentOn`: as `resolveDate`, except that a
 * month without a day, as in "bis Ende November", is its last day, the latest a Task is in time.
 */
export function resolveDeadline(mention: DateMention, sentOn: LocalDate): ResolvedDate {
  const { day, month, year, weekday, daysAfter } = mention;
  if (day !== null || month === null || weekday !== null || daysAfter !== null) return resolveDate(mention, sentOn);
  const date = deadlineDate(month, year, sentOn);
  return date === null ? { ok: false, problem: "no-date" } : { ok: true, date };
}

/** Day 0 of the next month is this month's last day. */
function deadlineDate(month: number, year: number | null, sentOn: LocalDate): LocalDate | null {
  const lastDay = (inYear: number) =>
    month >= 1 && month <= 12 ? (new Date(Date.UTC(inYear, month, 0)).toISOString().slice(0, 10) as LocalDate) : null;
  if (year !== null) return lastDay(year < 100 ? 2000 + year : year);
  const thisYear = Number(sentOn.slice(0, 4));
  const candidate = lastDay(thisYear);
  return candidate && candidate < addDays(sentOn, -daysBackWithoutYear) ? lastDay(thisYear + 1) : candidate;
}

/** The instant a wall-clock time `HH:MM` shows on a date in the time zone, or null if it is no time. */
export function instantAt(date: LocalDate, time: string, timeZone: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offset at the guess, then at the corrected instant, which settles across a change.
  const offsetAt = (instant: number) => {
    const local = localDateTime(new Date(instant), timeZone);
    return new Date(`${local.date}T${local.time}:00Z`).getTime() - instant;
  };
  const first = wall - offsetAt(wall);
  return new Date(wall - offsetAt(first));
}

/**
 * Whether a quote appears in a message word for word. Only whitespace may differ, as a model
 * joins lines a message breaks.
 */
export function quoteFoundIn(quote: string, message: string): boolean {
  const normal = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();
  const needle = normal(quote);
  return needle !== "" && normal(message).includes(needle);
}

function dateOf(year: number, month: number, day: number): LocalDate | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10) as LocalDate;
}

/** The day of the week a date falls on. */
export function weekdayOf(date: LocalDate): Weekday {
  return weekdays[weekdayIndex(date)] ?? "monday";
}

/** Monday is 0. */
function weekdayIndex(date: LocalDate): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}
