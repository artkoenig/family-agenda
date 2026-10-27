import {
  addDays,
  eventOf,
  instantAt,
  localDateTime,
  problemsWithEventRevision,
  quoteFoundIn,
  resolveDate,
  weekdayOf,
  type Act,
  type Event,
  type LocalDate,
  type RawMessageId,
  type TimeSpan,
} from "@family-butler/domain";
import { llmEndpointOf } from "./llm-endpoint";
import type {
  BlobStore,
  Clock,
  ExtractedEvent,
  ExtractionResult,
  Extractor,
  FamilyRepository,
  ItemRepository,
  KnownEvent,
  LlmEndpoint,
  LlmEndpointRepository,
  NewRevision,
  PendingMessage,
  Rejection,
  SecretStore,
  ThreadItem,
} from "./ports";
import { project } from "./revisions";

export type ExtractionDeps = {
  clock: Clock;
  /** The IANA time zone the Family lives in, which a message's dates and times are read in. */
  timeZone: string;
  families: FamilyRepository;
  endpoints: LlmEndpointRepository;
  secrets: SecretStore;
  items: ItemRepository;
  blobs: BlobStore;
  extractor: Extractor;
};

export type ExtractionReport = {
  /** The messages extracted successfully, whether they stated anything or not. */
  extracted: RawMessageId[];
  /** The messages that wait for the next run. */
  failed: { messageId: RawMessageId; problem: Extract<ExtractionResult, { ok: false }>["problem"]; message: string }[];
};

/** How many messages one run extracts at most, so that a run stays short. */
const batchSize = 20;

/**
 * Extraction of Items from raw messages (ADR-0009): once per message, through the Family's LLM
 * endpoint. The model only reads; code resolves dates against the send time and rejects what the
 * message does not say.
 */
export function createExtraction(deps: ExtractionDeps) {
  const { clock, timeZone, items, blobs, extractor } = deps;

  async function extractOne(message: PendingMessage, text: string, endpoint: LlmEndpoint) {
    const thread = message.thread ? await items.itemsOfThread(message.sourceId, message.thread) : [];
    const known = knownEventsOf(thread, timeZone);
    const sent = localDateTime(message.sentAt, timeZone);
    const result = await extractor.extract({
      endpoint,
      message: { text, sent: { ...sent, weekday: weekdayOf(sent.date) } },
      knownEvents: known.map(({ ref, title, when, place }) => ({ ref, title, when, place })),
    });
    if (!result.ok) return result;
    const reading: Reading = { message, text, sentOn: sent.date, timeZone, known };
    const revisions = result.events.flatMap((event, index) => {
      const revision = revisionOf(event, index, reading);
      return revision ? [revision] : [];
    });
    await items.recordExtraction(
      { messageId: message.id, familyId: message.familyId, sourceId: message.sourceId, at: clock.now(), revisions },
      project,
    );
    return result;
  }

  return {
    /**
     * Extracts the messages that wait for it, as the worker does on each tick. Without an LLM
     * endpoint they keep waiting; when the endpoint cannot be reached or refuses the key, the rest
     * wait for the next run, since they would fail the same way.
     */
    async extractPending(): Promise<ExtractionReport> {
      const report: ExtractionReport = { extracted: [], failed: [] };
      const endpoint = await llmEndpointOf(deps);
      if (!endpoint) return report;
      for (const message of await items.pendingMessages(batchSize)) {
        const bytes = await blobs.get(message.text);
        if (!bytes) {
          // Its text was deleted before it was read, so it states nothing.
          await items.recordExtraction(
            { messageId: message.id, familyId: message.familyId, sourceId: message.sourceId, at: clock.now(), revisions: [] },
            project,
          );
          report.extracted.push(message.id);
          continue;
        }
        const result = await extractOne(message, new TextDecoder().decode(bytes), endpoint);
        if (result.ok) {
          report.extracted.push(message.id);
          continue;
        }
        report.failed.push({ messageId: message.id, problem: result.problem, message: result.message });
        if (result.problem !== "invalid-output") break;
      }
      return report;
    },
  };
}

export type ExtractionAccess = ReturnType<typeof createExtraction>;

/** An Event of the thread as the model is told about it, with the Item it is. */
type Known = KnownEvent & { itemKey: string; event: Event };

type Reading = {
  message: PendingMessage;
  text: string;
  sentOn: LocalDate;
  timeZone: string;
  known: Known[];
};

/** The Events earlier messages of the thread stated, numbered for the model as E1, E2, … */
function knownEventsOf(thread: ThreadItem[], timeZone: string): Known[] {
  const events = thread.flatMap((item) => {
    const event = item.kind === "event" ? eventOf(item.folded) : null;
    return event && !event.cancelled ? [{ itemKey: item.itemKey, event }] : [];
  });
  return events.map(({ itemKey, event }, index) => ({
    itemKey,
    event,
    ref: `E${index + 1}`,
    title: event.title,
    when: whenOf(event.span, timeZone),
    place: event.place,
  }));
}

/** A span as the model is told it, on the Family's clocks, such as `2026-09-17 19:30–20:30`. */
function whenOf(span: TimeSpan, timeZone: string): string {
  if (span.allDay) {
    const days = span.firstDay === span.lastDay ? span.firstDay : `${span.firstDay} to ${span.lastDay}`;
    return `${days}, all day`;
  }
  const start = localDateTime(span.start, timeZone);
  const end = localDateTime(span.end, timeZone);
  return `${start.date} ${start.time}–${end.date === start.date ? "" : `${end.date} `}${end.time}`;
}

/**
 * The Revision an extracted Event states, rejected automatically when the message does not quote
 * it, or its date cannot be resolved or has the wrong weekday; null when it states nothing.
 */
function revisionOf(extracted: ExtractedEvent, index: number, reading: Reading): NewRevision | null {
  const { message, text, sentOn, timeZone } = reading;
  const target = extracted.updates ? reading.known.find((known) => known.ref === extracted.updates) : undefined;
  // A new Event that is cancelled at once is only information.
  if (!target && extracted.cancelled) return null;

  let rejection: Rejection | null = quoteFoundIn(extracted.evidence, text) ? null : "evidence-not-found";
  const mention = extracted.date;
  const mentioned = Object.values(mention).some((part) => part !== null);
  const resolved = mentioned ? resolveDate(mention, sentOn) : null;
  if (resolved && !resolved.ok) rejection ??= resolved.problem;
  if (!target && !mentioned) rejection ??= "no-date";

  // A rejected Revision keeps the date the message states, for an Admin who restores it.
  const date = resolved && "date" in resolved ? resolved.date : null;
  const span = spanOf({ date, start: extracted.startTime, end: extracted.endTime, known: target?.event ?? null, timeZone });
  const fields: Record<string, unknown> = {};
  let act: Act;
  if (!target) {
    act = "create";
    fields.title = extracted.title;
    fields.span = span;
    fields.place = extracted.place;
  } else if (extracted.cancelled) {
    act = "cancel";
  } else {
    if (extracted.title !== null) fields.title = extracted.title;
    if (extracted.place !== null) fields.place = extracted.place;
    const moved = date !== null || extracted.startTime !== null;
    if (moved) fields.span = span;
    act = moved ? "move" : "change";
    if (Object.keys(fields).length === 0 && rejection === null) return null;
  }
  if (rejection === null && problemsWithEventRevision(act, fields).length > 0) rejection = "invalid-fields";
  return {
    itemKind: "event",
    itemKey: target?.itemKey ?? `${message.externalId}#${index + 1}`,
    act,
    fields,
    sourceTime: message.sentAt,
    accepted: rejection === null,
    rejection,
    evidence: extracted.evidence,
  };
}

/**
 * The span an Event is moved to or created with, as JSON: on the stated date, or the known
 * Event's, at the stated times, or the known Event's times of day. A stated start without an end
 * keeps the known Event's duration, or has none for a new Event; without any time it is all day.
 */
function spanOf(input: {
  date: LocalDate | null;
  start: string | null;
  end: string | null;
  known: Event | null;
  timeZone: string;
}): Record<string, unknown> | null {
  const { known, timeZone } = input;
  const knownSpan: TimeSpan | null = known?.span ?? null;
  const day = input.date ?? (knownSpan ? (knownSpan.allDay ? knownSpan.firstDay : localDateTime(knownSpan.start, timeZone).date) : null);
  if (!day) return null;
  const startTime = input.start ?? (knownSpan && !knownSpan.allDay ? localDateTime(knownSpan.start, timeZone).time : null);
  if (startTime === null) {
    const length = knownSpan?.allDay ? daysBetween(knownSpan.firstDay, knownSpan.lastDay) : 0;
    return { allDay: true, firstDay: day, lastDay: addDays(day, length) };
  }
  const start = instantAt(day, startTime, timeZone);
  if (!start) return null;
  let end: Date | null = start;
  if (input.end !== null) {
    end = instantAt(day, input.end, timeZone);
    // An end before the start is on the next day, as for a sleepover.
    if (end && end < start) end = instantAt(addDays(day, 1), input.end, timeZone);
  } else if (knownSpan && !knownSpan.allDay) {
    end = new Date(start.getTime() + (knownSpan.end.getTime() - knownSpan.start.getTime()));
  }
  if (!end) return null;
  return { allDay: false, start: start.toISOString(), end: end.toISOString() };
}

function daysBetween(first: LocalDate, last: LocalDate): number {
  return Math.round((new Date(`${last}T00:00:00Z`).getTime() - new Date(`${first}T00:00:00Z`).getTime()) / 86_400_000);
}
