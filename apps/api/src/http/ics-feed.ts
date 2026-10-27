import type { FeedEvent, ViewFeed } from "@family-butler/application";
import { addDays, type LocalDate } from "@family-butler/domain";
import { spanLabel } from "./view-page";

/**
 * A View's feed as an iCalendar document (RFC 5545), for calendar apps that subscribe to it. Each
 * Event keeps its Item's id as its UID, so that apps update it in place.
 */
export function icsFeed(feed: ViewFeed, viewLink: string): string {
  const stamp = instant(feed.generatedAt);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Family Butler//View feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Family Butler",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...feed.events.flatMap((event) => vevent(event, stamp, viewLink)),
    "END:VCALENDAR",
  ];
  return lines.map(folded).join("\r\n") + "\r\n";
}

function vevent(event: FeedEvent, stamp: string, viewLink: string): string[] {
  const { span } = event;
  const details = [spanLabel(event.when), event.place, event.cancelled ? "Cancelled" : null].filter(Boolean);
  return [
    "BEGIN:VEVENT",
    `UID:${event.itemId}@family-butler`,
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
