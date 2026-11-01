import ICAL from "ical.js";
import {
  sdkVersion,
  SourceError,
  type EventFields,
  type EventSpan,
  type Origin,
  type PluginRevision,
  type RunContext,
  type SourcePlugin,
} from "@family-agenda/source-sdk";

export type IcsPluginOptions = {
  /** How the plugin reaches the calendar; recorded responses in tests. */
  fetch?: typeof globalThis.fetch;
  /** How long a download may take before the run fails, so that one calendar cannot hold up the rest. */
  timeoutMs?: number;
};

/**
 * What a calendar entry said the last time the plugin saw it. An entry that has gone from the
 * calendar is kept, cancelled, with the time it was noticed gone.
 */
type Entry = { title: string; span: EventSpan; place: string | null; cancelled: boolean; goneAt?: string };

/** The sync cursor: the calendar's ETag and every entry as last seen, by UID. */
type State = { etag: string | null; entries: Record<string, Entry> };

type Download = { body: string; etag: string | null };

/**
 * Reads a calendar from its secret ICS address and states its Events as Revisions keyed by UID,
 * at their `LAST-MODIFIED`. An ICS file has no change feed, so each run compares the calendar with
 * the entries the last run saw and states only what changed. Recurring entries are left out for
 * now; they need expanding into occurrences (#39).
 */
export function createIcsPlugin(options: IcsPluginOptions = {}): SourcePlugin {
  const fetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  /** The calendar, or null if it has not changed since the given ETag. */
  async function download(context: RunContext, etag: string | null): Promise<Download | null> {
    const url = addressOf(context.config.secrets.url);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: etag ? { "if-none-match": etag } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw SourceError.temporary(`The calendar could not be reached: ${reason}`);
    }
    if (response.status === 304) return null;
    if (!response.ok) {
      const temporary = response.status >= 500 || response.status === 408 || response.status === 429;
      const message = `The calendar answered with HTTP ${response.status}.`;
      throw temporary ? SourceError.temporary(message) : SourceError.definite(message);
    }
    return { body: await response.text(), etag: response.headers.get("etag") };
  }

  return {
    identity: { sourceTypeId: "ics", displayName: { en: "ICS calendar", de: "ICS-Kalender" }, version: "0.1.0", sdkVersion },
    configuration: {
      version: 1,
      fields: [
        {
          key: "url",
          label: { en: "Secret ICS address", de: "Geheime ICS-Adresse" },
          secret: true,
          required: true,
          description: {
            en: 'Such as Google Calendar\'s "Secret address in iCal format". Anyone with it can read the calendar.',
            de: "Etwa die „Privatadresse im iCal-Format“ von Google Kalender. Wer sie kennt, kann den Kalender lesen.",
          },
        },
        {
          key: "name",
          label: { en: "Calendar name", de: "Name des Kalenders" },
          secret: false,
          required: false,
          description: {
            en: "Optional; by default the name the calendar gives itself.",
            de: "Optional; sonst der Name, den der Kalender sich selbst gibt.",
          },
        },
      ],
    },
    setupSteps: [],
    ingestion: {
      mode: "polling",
      suggestedIntervalSeconds: 15 * 60,
      async poll(context) {
        const previous = parseState(context.syncCursor);
        const downloaded = await download(context, previous.etag);
        if (!downloaded) return { origins: [], syncCursor: context.syncCursor };
        const calendar = parseCalendar(downloaded.body, context.timeZone);
        const attributes = { calendar: nameOf(context, calendar.name) };

        const origins: Origin[] = [];
        const entries: Record<string, Entry> = {};
        for (const found of calendar.entries) {
          entries[found.uid] = found.entry;
          const before = previous.entries[found.uid];
          const revisions = revisionsFor(found.uid, before, found.entry);
          if (revisions.length === 0) continue;
          origins.push({
            externalId: found.uid,
            // An entry back from being gone comes back now, after its cancellation.
            occurredAt: before?.goneAt ? context.now : (found.lastModified ?? context.now),
            attributes,
            ...(found.link ? { link: found.link } : {}),
            content: { kind: "revisions", revisions },
          });
        }
        // An entry deleted from the calendar is cancelled when a run notices it is gone.
        for (const [uid, entry] of Object.entries(previous.entries)) {
          if (uid in entries) continue;
          entries[uid] = entry.goneAt ? entry : { ...entry, cancelled: true, goneAt: context.now.toISOString() };
          if (entry.cancelled) continue;
          origins.push({
            externalId: uid,
            occurredAt: context.now,
            attributes,
            content: { kind: "revisions", revisions: [revision(uid, "cancel", {})] },
          });
        }
        const state: State = { etag: downloaded.etag, entries };
        return { origins, syncCursor: JSON.stringify(state) };
      },
    },
    health: { silentApplies: false },
  };
}

export default createIcsPlugin();

/** The address to download; `webcal:` is how calendar apps are offered the same `https:` one. */
function addressOf(value: string | undefined): string {
  const address = (value ?? "").trim().replace(/^webcal:\/\//i, "https://");
  if (!URL.canParse(address) || !["http:", "https:"].includes(new URL(address).protocol)) {
    throw SourceError.definite("The ICS address is no http or https address.");
  }
  return address;
}

function nameOf(context: RunContext, calendarName: string | null): string {
  const name = context.config.plain.name;
  if (typeof name === "string" && name.trim() !== "") return name.trim();
  return calendarName ?? "Calendar";
}

function parseState(state: string | null): State {
  if (state === null) return { etag: null, entries: {} };
  try {
    const parsed = JSON.parse(state) as Partial<State>;
    return { etag: parsed.etag ?? null, entries: parsed.entries ?? {} };
  } catch {
    return { etag: null, entries: {} };
  }
}

/** What to state about an entry, given how the last run saw it. */
function revisionsFor(uid: string, before: Entry | undefined, now: Entry): PluginRevision[] {
  const all: EventFields = { title: now.title, span: now.span, place: now.place };
  if (!before || (before.cancelled && !now.cancelled)) {
    return [revision(uid, "create", all), ...(now.cancelled ? [revision(uid, "cancel", {})] : [])];
  }
  if (now.cancelled) return before.cancelled ? [] : [revision(uid, "cancel", {})];
  const changed: EventFields = {};
  if (before.title !== now.title) changed.title = now.title;
  if (JSON.stringify(before.span) !== JSON.stringify(now.span)) changed.span = now.span;
  if (before.place !== now.place) changed.place = now.place;
  const keys = Object.keys(changed);
  if (keys.length === 0) return [];
  return [revision(uid, keys.length === 1 && "span" in changed ? "move" : "change", changed)];
}

function revision(uid: string, action: PluginRevision["action"], fields: EventFields): PluginRevision {
  return { itemKind: "event", itemKey: uid, action, fields };
}

type FoundEntry = { uid: string; entry: Entry; lastModified: Date | null; link: string | null };

function parseCalendar(body: string, familyTimeZone: string): { name: string | null; entries: FoundEntry[] } {
  let calendar: ICAL.Component;
  try {
    calendar = new ICAL.Component(ICAL.parse(body) as unknown[]);
  } catch {
    throw SourceError.definite("The ICS address returns no calendar.");
  }
  if (calendar.name !== "vcalendar") throw SourceError.definite("The ICS address returns no calendar.");

  const zones = new Map<string, ICAL.Timezone>();
  for (const component of calendar.getAllSubcomponents("vtimezone")) {
    const zone = new ICAL.Timezone(component);
    zones.set(zone.tzid, zone);
  }
  const instant = (property: ICAL.Property | null) => {
    const time = property?.getFirstValue();
    if (!(time instanceof ICAL.Time)) return null;
    const tzid = property?.getParameter("tzid");
    return instantOf(time, typeof tzid === "string" ? tzid : null, zones, familyTimeZone);
  };

  const entries: FoundEntry[] = [];
  for (const component of calendar.getAllSubcomponents("vevent")) {
    const uid = text(component.getFirstPropertyValue("uid"));
    const start = component.getFirstProperty("dtstart")?.getFirstValue();
    const recurring = ["rrule", "rdate", "recurrence-id"].some((name) => component.hasProperty(name));
    if (!uid || !(start instanceof ICAL.Time) || recurring) continue;
    const event = new ICAL.Event(component);
    const span = start.isDate
      ? allDaySpan(start, event.endDate)
      : timedSpan(instant(component.getFirstProperty("dtstart")), endInstant(component, instant));
    if (!span) continue;
    const lastModified = component.getFirstPropertyValue("last-modified");
    const link = text(component.getFirstPropertyValue("url"));
    entries.push({
      uid,
      entry: {
        title: text(event.summary) ?? "(No title)",
        span,
        place: text(event.location),
        cancelled: text(component.getFirstPropertyValue("status"))?.toUpperCase() === "CANCELLED",
      },
      lastModified: lastModified instanceof ICAL.Time ? lastModified.toJSDate() : null,
      link: link && /^https?:\/\//i.test(link) ? link : null,
    });
  }
  return { name: text(calendar.getFirstPropertyValue("x-wr-calname")), entries };
}

/** The end of a timed entry: its `DTEND`, or its start plus its `DURATION`, or its start. */
function endInstant(component: ICAL.Component, instant: (property: ICAL.Property | null) => Date | null): Date | null {
  if (component.hasProperty("dtend")) return instant(component.getFirstProperty("dtend"));
  const start = instant(component.getFirstProperty("dtstart"));
  if (!start) return null;
  const duration = component.getFirstPropertyValue("duration");
  return duration instanceof ICAL.Duration
    ? new Date(start.getTime() + duration.toSeconds() * 1000)
    : start;
}

function timedSpan(start: Date | null, end: Date | null): EventSpan | null {
  if (!start || !end || end < start) return null;
  return { allDay: false, start: start.toISOString(), end: end.toISOString() };
}

/** Whole days, both included; an all-day entry's `DTEND` is the day after its last. */
function allDaySpan(start: ICAL.Time, end: ICAL.Time): EventSpan | null {
  const firstDay = dateOf(start);
  const last = end.clone();
  last.adjust(-1, 0, 0, 0);
  const lastDay = end.compare(start) > 0 ? dateOf(last) : firstDay;
  return lastDay >= firstDay ? { allDay: true, firstDay, lastDay } : null;
}

function dateOf(time: ICAL.Time): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}`;
}

/**
 * The instant a calendar time stands for. ical.js knows UTC; a named zone is taken from the
 * system's time zone database where it knows the name, as Google's and Apple's are, else from the
 * calendar's own `VTIMEZONE`; a time without a zone is in the Family's.
 */
function instantOf(time: ICAL.Time, tzid: string | null, zones: Map<string, ICAL.Timezone>, familyTimeZone: string): Date {
  if (time.zone === ICAL.Timezone.utcTimezone) return time.toJSDate();
  if (tzid && isKnownTimeZone(tzid)) return zonedInstant(time, tzid);
  const zone = tzid ? zones.get(tzid) : undefined;
  if (zone) {
    const zoned = time.clone();
    zoned.zone = zone;
    return new Date(zoned.toUnixTime() * 1000);
  }
  return zonedInstant(time, familyTimeZone);
}

function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The instant a wall-clock time shows in an IANA time zone. */
function zonedInstant(time: ICAL.Time, timeZone: string): Date {
  const wallClock = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      })
        .formatToParts(instant)
        .map((part) => [part.type, Number(part.value)]),
    ) as Record<string, number>;
    const shown = Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day, parts.hour, parts.minute, parts.second);
    return shown - instant;
  };
  // The offset at the wall-clock time read as UTC is right except near a change of offset,
  // where the offset at the first guess is.
  const guess = wallClock - offsetAt(wallClock);
  return new Date(wallClock - offsetAt(guess));
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
