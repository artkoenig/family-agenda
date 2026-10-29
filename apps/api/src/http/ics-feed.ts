import type { FeedEvent, FeedSchoolDay, TimelineLesson, TimelineTimetableChange, ViewFeed } from "@family-agenda/application";
import { addDays, type LocalDate } from "@family-agenda/domain";
import { translationFor, type Translation } from "./i18n/translation";
import { changeLabel, spanLabel } from "./view-page";

/**
 * A View's feed as an iCalendar document (RFC 5545), for calendar apps that subscribe to it. Each
 * Event keeps its Item's id as its UID, and each school day its key, so that apps update it in
 * place.
 */
export function icsFeed(feed: ViewFeed, viewLink: string): string {
  const stamp = instant(feed.generatedAt);
  const translation = translationFor(feed.language);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Family Agenda//View feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Family Agenda",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...feed.events.flatMap((event) => vevent(event, stamp, viewLink, translation)),
    ...feed.schoolDays.flatMap((day) => schoolDayVevent(day, stamp, viewLink, translation)),
    "END:VCALENDAR",
  ];
  return lines.map(folded).join("\r\n") + "\r\n";
}

function vevent(event: FeedEvent, stamp: string, viewLink: string, translation: Translation): string[] {
  const { span } = event;
  const { t } = translation;
  const details = [spanLabel(event.when, translation), event.place, event.cancelled ? t.view.cancelled : null].filter(Boolean);
  return [
    "BEGIN:VEVENT",
    `UID:${event.itemId}@family-agenda`,
    `DTSTAMP:${stamp}`,
    ...(span.allDay
      ? [`DTSTART;VALUE=DATE:${date(span.firstDay)}`, `DTEND;VALUE=DATE:${date(addDays(span.lastDay, 1))}`]
      : [`DTSTART:${instant(span.start)}`, `DTEND:${instant(span.end)}`]),
    `SUMMARY:${text(event.title)}`,
    ...(event.place ? [`LOCATION:${text(event.place)}`] : []),
    `DESCRIPTION:${text(`${details.join("\n")}\n\n${viewLink}`)}`,
    `URL:${viewLink}`,
    ...(event.cancelled ? ["STATUS:CANCELLED"] : []),
    "END:VEVENT",
  ];
}

/**
 * A school day as an all-day entry: "School", after the names of the Family Members it concerns
 * where the feed names them, marked with ⚠ when the day has a Timetable Change. Its details list
 * the Lessons, each with its Timetable Change; a day whose every Lesson is cancelled is cancelled.
 */
function schoolDayVevent(day: FeedSchoolDay, stamp: string, viewLink: string, { t }: Translation): string[] {
  const title = day.names.length > 0 ? `${day.names.join(", ")}: ${t.view.school}` : t.view.school;
  const changeOf = (lesson: TimelineLesson) => day.timetableChanges.find((change) => sameSlot(change, lesson));
  const lines = day.lessons.map((lesson) => {
    const change = changeOf(lesson);
    return `${lesson.from} – ${lesson.until} ${lesson.subject}${change ? `: ${changeLabel(change, t)}` : ""}`;
  });
  // A Timetable Change of a Lesson the day does not list, such as one added to it, has a line of its own.
  for (const change of day.timetableChanges) {
    if (!day.lessons.some((lesson) => sameSlot(change, lesson))) {
      lines.push(`${change.from} – ${change.until} ${change.subject}: ${changeLabel(change, t)}`);
    }
  }
  return [
    "BEGIN:VEVENT",
    `UID:school-${day.key}@family-agenda`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${date(day.date)}`,
    `DTEND;VALUE=DATE:${date(addDays(day.date, 1))}`,
    `SUMMARY:${text(day.timetableChanges.length > 0 ? `⚠ ${title}` : title)}`,
    `DESCRIPTION:${text(`${lines.join("\n")}\n\n${viewLink}`)}`,
    `URL:${viewLink}`,
    ...(day.cancelled ? ["STATUS:CANCELLED"] : []),
    "END:VEVENT",
  ];
}

/** Whether a Timetable Change is that of a Lesson: the same subject at the same time. */
function sameSlot(change: TimelineTimetableChange, lesson: TimelineLesson): boolean {
  return change.subject === lesson.subject && change.from === lesson.from && change.until === lesson.until;
}

/** An instant in UTC, as `20260915T140000Z`. */
function instant(at: Date): string {
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function date(day: LocalDate): string {
  return day.replaceAll("-", "");
}

/** A TEXT value with its backslashes, separators and line breaks escaped. */
function text(value: string): string {
  return value.replace(/[\\;,]/g, (char) => `\\${char}`).replace(/\r?\n/g, "\\n");
}

/** Folds a content line into lines of at most 75 octets, never splitting a character. */
function folded(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let part = "";
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    // Continuation lines start with a space, which counts towards their 75 octets.
    if (octets + size > (parts.length === 0 ? 75 : 74)) {
      parts.push(part);
      part = "";
      octets = 0;
    }
    part += char;
    octets += size;
  }
  parts.push(part);
  return parts.join("\r\n ");
}
