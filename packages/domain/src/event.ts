import { addDays, localDateTime, type LocalDate, type LocalTime } from "./calendar";
import type { Act, FoldedItem } from "./item";

/**
 * When an Event takes place: from one instant to another, or whole days in the Family's time
 * zone, both days included.
 */
export type TimeSpan =
  | { allDay: false; start: Date; end: Date }
  | { allDay: true; firstDay: LocalDate; lastDay: LocalDate };

export type Event = { title: string; span: TimeSpan; place: string | null; cancelled: boolean };

export const maximumEventTextLength = 500;

/**
 * The fields of an Event Revision, as a Source states them in JSON: `title` (text), `span`
 * (`{ allDay: false, start, end }` with ISO instants, or `{ allDay: true, firstDay, lastDay }`
 * with `YYYY-MM-DD` dates) and `place` (text or null).
 */
const eventFields = ["title", "span", "place"] as const;

/** Why an Event Revision cannot be applied; none if it can. */
export function problemsWithEventRevision(act: Act, fields: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const required = act === "create" ? ["title", "span"] : act === "move" ? ["span"] : [];
  for (const key of required) if (!(key in fields)) problems.push(`${key} is missing`);
  if ("title" in fields && parseText(fields.title) === null) problems.push("title is not a non-empty text");
  if ("span" in fields && parseSpan(fields.span) === null) problems.push("span is not a valid time span");
  if ("place" in fields && fields.place !== null && parseText(fields.place) === null) {
    problems.push("place is not a non-empty text or null");
  }
  for (const key of Object.keys(fields)) {
    if (!(eventFields as readonly string[]).includes(key)) problems.push(`${key} is not a field of an Event`);
  }
  return problems;
}

/** The Event its folded Revisions describe, or null while it has no title or span yet. */
export function eventOf(folded: FoldedItem | null): Event | null {
  if (!folded) return null;
  const title = parseText(folded.fields.title);
  const span = parseSpan(folded.fields.span);
  if (title === null || span === null) return null;
  return { title, span, place: parseText(folded.fields.place), cancelled: folded.cancelled };
}

/**
 * How a span shows on one day of the Family: the time it starts and ends that day, each null if
 * it started before or ends after that day, or null if it does not touch the day at all.
 */
export function spanOnDay(
  span: TimeSpan,
  day: LocalDate,
  timeZone: string,
): { from: LocalTime | null; until: LocalTime | null } | null {
  if (span.allDay) return span.firstDay <= day && day <= span.lastDay ? { from: null, until: null } : null;
  const start = localDateTime(span.start, timeZone);
  const end = localDateTime(span.end, timeZone);
  // An end at midnight belongs to the day before, unless the Event has no duration.
  const lastDay =
    span.end > span.start ? localDateTime(new Date(span.end.getTime() - 1), timeZone).date : start.date;
  if (day < start.date || day > lastDay) return null;
  return { from: day === start.date ? start.time : null, until: day === lastDay ? end.time : null };
}

/**
 * Instants certainly before and after the span, whatever the Family's time zone: lets a store
 * find the Events of some days without knowing the time zone.
 */
export function spanBounds(span: TimeSpan): { from: Date; to: Date } {
  if (!span.allDay) return { from: span.start, to: span.end };
  const day = 24 * 60 * 60 * 1000;
  return {
    from: new Date(new Date(`${span.firstDay}T00:00:00Z`).getTime() - day),
    to: new Date(new Date(`${addDays(span.lastDay, 1)}T00:00:00Z`).getTime() + day),
  };
}

function parseText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text !== "" && text.length <= maximumEventTextLength ? text : null;
}

function parseSpan(value: unknown): TimeSpan | null {
  if (typeof value !== "object" || value === null) return null;
  const span = value as Record<string, unknown>;
  if (span.allDay === true) {
    const firstDay = parseDate(span.firstDay);
    const lastDay = parseDate(span.lastDay);
    return firstDay && lastDay && firstDay <= lastDay ? { allDay: true, firstDay, lastDay } : null;
  }
  if (span.allDay !== false || typeof span.start !== "string" || typeof span.end !== "string") return null;
  const start = new Date(span.start);
  const end = new Date(span.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  return { allDay: false, start, end };
}

function parseDate(value: unknown): LocalDate | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? (value as LocalDate) : null;
}
