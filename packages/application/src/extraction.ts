import {
  addDays,
  eventOf,
  instantAt,
  localDateTime,
  problemsWithEventRevision,
  problemsWithTaskRevision,
  quoteFoundIn,
  resolveDate,
  resolveDeadline,
  taskOf,
  weekdayOf,
  type Act,
  type Event,
  type LocalDate,
  type RawMessageId,
  type SourceId,
  type Task,
  type TimeSpan,
} from "@family-agenda/domain";
import type { ActivityLog } from "./activity";
import { llmEndpointOf } from "./llm-endpoint";
import type {
  AttachmentProblem,
  BlobStore,
  Clock,
  Conversion,
  ExtractedEvent,
  ExtractedTask,
  ExtractionResult,
  Extractor,
  FamilyRepository,
  ItemRepository,
  KnownEvent,
  KnownTask,
  LlmEndpoint,
  LlmEndpointRepository,
  NewRevision,
  OcrModelStore,
  PendingAttachment,
  PendingMessage,
  Rejection,
  SecretStore,
  TextExtractor,
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
  textExtractor: TextExtractor;
  /** The Tesseract models OCR needs for the Family's OCR languages. */
  ocrModels: OcrModelStore;
  /** Where the run shows as the worker's activity. */
  activity: ActivityLog;
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
  const { clock, timeZone, families, items, blobs, extractor, textExtractor, ocrModels, activity } = deps;

  /**
   * The text of a PDF attachment: its text layer, and the pages that are scans read by OCR when
   * it is switched on. Only text goes to the LLM endpoint, so that a large file cannot overrun its context.
   */
  async function textOf(attachment: PendingAttachment): Promise<Conversion<string>> {
    const bytes = await blobs.get(attachment.blob);
    if (!bytes) return { ok: false, message: "The file has been deleted." };
    const layer = await textExtractor.textLayer(bytes);
    if (!layer.ok) return layer;
    const pages = layer.value;
    const scans = pages.flatMap((page, index) => (isScan(page) ? [index + 1] : []));
    if (scans.length > maximumScannedPages) {
      return { ok: false, message: `It has ${scans.length} scanned pages; at most ${maximumScannedPages} are read.` };
    }
    const scanned = scans.length > 0 ? await readScans(bytes, scans) : ({ ok: true, value: [] } as const);
    if (!scanned.ok) return scanned;
    const text = pages.map((page, index) => {
      const scan = scans.indexOf(index + 1);
      return (scan >= 0 ? (scanned.value[scan] ?? "") : page).trim();
    });
    return { ok: true, value: text.filter((page) => page !== "").join("\n\n") };
  }

  async function readScans(pdf: Uint8Array, pages: number[]): Promise<Conversion<string[]>> {
    if (!(await families.ocrEnabled())) return { ok: false, message: "OCR is switched off." };
    const { ocrLanguages } = await families.languages();
    // Without a chosen model OCR would read worse in the others, so the scan stays unread.
    const installed = new Set((await ocrModels.installed()).map((model) => model.language));
    const missing = ocrLanguages.find((language) => !installed.has(language));
    if (missing) return { ok: false, message: `OCR language \`${missing}\` is not installed.` };
    return textExtractor.ocr(pdf, pages, ocrLanguages);
  }

  /**
   * The message's text followed by the text of its PDF attachments, which extraction reads as one,
   * and the attachments that could not be read.
   */
  async function fullTextOf(message: PendingMessage, text: string) {
    const parts = [text];
    const problems: AttachmentProblem[] = [];
    for (const attachment of message.attachments.filter(isPdf)) {
      const read = await textOf(attachment);
      if (!read.ok) problems.push({ position: attachment.position, problem: read.message });
      else if (read.value !== "") parts.push(`Attachment ${attachment.filename}:\n${read.value}`);
    }
    return { text: parts.join("\n\n"), problems };
  }

  async function extractOne(message: PendingMessage, text: string, problems: AttachmentProblem[], endpoint: LlmEndpoint) {
    const before = { messageId: message.id, sentAt: message.sentAt };
    const thread = message.thread ? await items.itemsOfThread(message.sourceId, message.thread, before, project) : [];
    const known = knownEventsOf(thread, timeZone);
    const knownTasks = knownTasksOf(thread);
    const sent = localDateTime(message.sentAt, timeZone);
    const result = await extractor.extract({
      endpoint,
      message: { text, sent: { ...sent, weekday: weekdayOf(sent.date) } },
      knownEvents: known.map(({ ref, title, when, place }) => ({ ref, title, when, place })),
      knownTasks: knownTasks.map(({ ref, title, deadline, bring }) => ({ ref, title, deadline, bring })),
    });
    if (result.ok) {
      const reading: Reading = { message, text, sentOn: sent.date, timeZone, known, knownTasks };
      const revisions = [
        ...result.events.map((event, index) => revisionOf(event, index, reading)),
        ...result.tasks.map((task, index) => taskRevisionOf(task, index, reading)),
      ].flatMap((revision) => (revision ? [revision] : []));
      await items.recordExtraction(
        {
          messageId: message.id,
          sourceId: message.sourceId,
          at: clock.now(),
          revisions,
          attachmentProblems: problems,
        },
        project,
      );
    }
    return result;
  }

  /** Extracts one message; the failure, if it failed. */
  async function extractMessage(message: PendingMessage, endpoint: LlmEndpoint): Promise<ExtractionReport["failed"][number] | null> {
    const full = await fullTextOf(message, message.body);
    const result = await extractOne(message, full.text, full.problems, endpoint);
    return result.ok ? null : { messageId: message.id, problem: result.problem, message: result.message };
  }

  return {
    /**
     * Has the messages of one Source, or of all, read again with the current prompt and model, as
     * after the prompt improved (ADR-0015). What they stated stays until each is read again.
     * Returns how many messages will be read again.
     */
    reread(scope: { sourceId?: SourceId } = {}): Promise<number> {
      return items.requestRereading(scope);
    },

    /** How many messages, of one Source or of all, wait to be read. */
    waiting(scope: { sourceId?: SourceId } = {}): Promise<number> {
      return items.pendingMessageCount(scope);
    },

    /**
     * Extracts the messages that wait for it, as the worker does on each tick. Without an LLM
     * endpoint they keep waiting; when the endpoint cannot be reached or refuses the key, the rest
     * wait for the next run, since they would fail the same way.
     */
    async extractPending(): Promise<ExtractionReport> {
      const report: ExtractionReport = { extracted: [], failed: [] };
      const endpoint = await llmEndpointOf(deps);
      if (!endpoint) return report;
      const pending = await items.pendingMessages(batchSize);
      if (pending.length === 0) return report;
      const progress = await activity.begin("extracting", pending.length);
      try {
        for (const message of pending) {
          const failure = await extractMessage(message, endpoint);
          if (failure) report.failed.push(failure);
          else report.extracted.push(message.id);
          await progress.advance();
          if (failure && failure.problem !== "invalid-output") break;
        }
      } finally {
        await progress.end();
      }
      return report;
    },
  };
}

export type ExtractionAccess = ReturnType<typeof createExtraction>;


/** How many scanned pages of one attachment are read at most, since each takes long or costs tokens. */
const maximumScannedPages = 10;

/** A page with fewer letters in its text layer is taken for a scan, such as one with only a page number. */
const minimumLettersOfText = 20;

function isScan(page: string): boolean {
  return (page.match(/\p{L}/gu)?.length ?? 0) < minimumLettersOfText;
}

/** Whether an attachment is a PDF, which mailers sometimes send as an unknown type with a `.pdf` name. */
function isPdf(attachment: PendingAttachment): boolean {
  return attachment.contentType.toLowerCase() === "application/pdf" || /\.pdf$/i.test(attachment.filename);
}

/** An Event of the thread as the model is told about it, with the Item it is. */
type Known = KnownEvent & { itemKey: string; event: Event };

/** A Task of the thread as the model is told about it, with the Item it is. */
type KnownTaskItem = KnownTask & { itemKey: string; task: Task };

type Reading = {
  message: PendingMessage;
  text: string;
  sentOn: LocalDate;
  timeZone: string;
  known: Known[];
  knownTasks: KnownTaskItem[];
};

/** The Tasks earlier messages of the thread stated, numbered for the model as T1, T2, … */
function knownTasksOf(thread: ThreadItem[]): KnownTaskItem[] {
  const tasks = thread.flatMap((item) => {
    const task = item.kind === "task" ? taskOf(item.folded) : null;
    return task && !task.cancelled ? [{ itemKey: item.itemKey, task }] : [];
  });
  return tasks.map(({ itemKey, task }, index) => ({
    itemKey,
    task,
    ref: `T${index + 1}`,
    title: task.title,
    deadline: task.deadline,
    bring: task.bring,
  }));
}

/**
 * The Revision an extracted Task states, rejected automatically when the message does not quote
 * it, or its Deadline cannot be resolved or has the wrong weekday; null when it states nothing.
 * A Task without a Deadline is due at once, so a new one needs no date.
 */
function taskRevisionOf(extracted: ExtractedTask, index: number, reading: Reading): NewRevision | null {
  const { message, text, sentOn } = reading;
  const target = extracted.updates ? reading.knownTasks.find((known) => known.ref === extracted.updates) : undefined;
  if (!target && extracted.cancelled) return null;
  const { rejection, deadline, mentioned } = taskRejection(extracted, text, sentOn);
  const result = taskActAndFields(extracted, target, deadline, mentioned, rejection);
  if (!result) return null;
  return buildTaskRevision(result, target, message, index, rejection, extracted);
}

function buildTaskRevision(result: { act: Act; fields: Record<string, unknown> }, target: KnownTaskItem | undefined, message: Reading["message"], index: number, rejection: Rejection | null, extracted: ExtractedTask): NewRevision {
  const { act, fields } = result;
  const finalRejection = rejection === null && problemsWithTaskRevision(act, fields).length > 0 ? "invalid-fields" : rejection;
  return {
    itemKind: "task",
    itemKey: target?.itemKey ?? `${message.externalId}#task-${index + 1}`,
    act,
    fields,
    sourceTime: message.sentAt,
    accepted: finalRejection === null,
    rejection: finalRejection,
    evidence: extracted.evidence,
  };
}

/** The rejection and resolved Deadline of an extracted Task. */
function taskRejection(extracted: ExtractedTask, text: string, sentOn: LocalDate): { rejection: Rejection | null; deadline: LocalDate | null; mentioned: boolean } {
  const rejection = quoteFoundIn(extracted.evidence, text) ? null : "evidence-not-found";
  const mentioned = Object.values(extracted.deadline).some((part) => part !== null);
  if (!mentioned) return { rejection, deadline: null, mentioned };
  const resolved = resolveDeadline(extracted.deadline, sentOn);
  // A rejected Revision keeps the Deadline the message states, for an Admin who restores it.
  const deadline = "date" in resolved ? resolved.date : null;
  return { rejection: resolved.ok ? rejection : (rejection ?? resolved.problem), deadline, mentioned };
}

/** The act and fields of a Task Revision; null when it changes nothing and is not rejected. */
function taskActAndFields(
  extracted: ExtractedTask,
  target: KnownTaskItem | undefined,
  deadline: LocalDate | null,
  mentioned: boolean,
  rejection: Rejection | null,
): { act: Act; fields: Record<string, unknown> } | null {
  if (!target) {
    return { act: "create", fields: { title: extracted.title, deadline, bring: extracted.bring } };
  }
  if (extracted.cancelled) return { act: "cancel", fields: {} };
  const fields: Record<string, unknown> = {};
  if (extracted.title !== null) fields.title = extracted.title;
  if (extracted.bring.length > 0) fields.bring = extracted.bring;
  if (mentioned) fields.deadline = deadline;
  return changeUnlessEmpty(mentioned ? "move" : "change", fields, rejection);
}

/** A change that states nothing is no Revision, unless it is rejected, so that an Admin sees why. */
function changeUnlessEmpty(act: Act, fields: Record<string, unknown>, rejection: Rejection | null): { act: Act; fields: Record<string, unknown> } | null {
  return Object.keys(fields).length === 0 && rejection === null ? null : { act, fields };
}

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
  if (span.allDay) return allDayOf(span);
  const start = localDateTime(span.start, timeZone);
  const end = localDateTime(span.end, timeZone);
  return timedOf(start, end);
}

function allDayOf(span: Extract<TimeSpan, { allDay: true }>): string {
  const days = span.firstDay === span.lastDay ? span.firstDay : `${span.firstDay} to ${span.lastDay}`;
  return `${days}, all day`;
}

function timedOf(start: { date: string; time: string }, end: { date: string; time: string }): string {
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
  const { rejection, date } = eventRejection(extracted, text, sentOn, target);
  const span = spanOf({ date, start: extracted.startTime, end: extracted.endTime, known: target?.event ?? null, timeZone });
  const result = eventActAndFields(extracted, target, date, span, rejection);
  if (!result) return null;
  return buildEventRevision(result, target, message, index, rejection, extracted);
}

function buildEventRevision(result: { act: Act; fields: Record<string, unknown> }, target: Known | undefined, message: Reading["message"], index: number, rejection: Rejection | null, extracted: ExtractedEvent): NewRevision {
  const { act, fields } = result;
  const finalRejection = rejection === null && problemsWithEventRevision(act, fields).length > 0 ? "invalid-fields" : rejection;
  return {
    itemKind: "event",
    itemKey: target?.itemKey ?? `${message.externalId}#${index + 1}`,
    act,
    fields,
    sourceTime: message.sentAt,
    accepted: finalRejection === null,
    rejection: finalRejection,
    evidence: extracted.evidence,
  };
}

/** The rejection and resolved date of an extracted Event. */
function eventRejection(
  extracted: ExtractedEvent,
  text: string,
  sentOn: LocalDate,
  target: Known | undefined,
): { rejection: Rejection | null; date: LocalDate | null } {
  let rejection: Rejection | null = quoteFoundIn(extracted.evidence, text) ? null : "evidence-not-found";
  const mention = extracted.date;
  const mentioned = Object.values(mention).some((part) => part !== null);
  if (!mentioned) {
    if (!target) rejection ??= "no-date";
    return { rejection, date: null };
  }
  const resolved = resolveDate(mention, sentOn);
  if (!resolved.ok) rejection ??= resolved.problem;
  // A rejected Revision keeps the date the message states, for an Admin who restores it.
  return { rejection, date: "date" in resolved ? resolved.date : null };
}

/** The act and fields of an Event Revision; null when it changes nothing and is not rejected. */
function eventActAndFields(
  extracted: ExtractedEvent,
  target: Known | undefined,
  date: LocalDate | null,
  span: Record<string, unknown> | null,
  rejection: Rejection | null,
): { act: Act; fields: Record<string, unknown> } | null {
  if (!target) {
    return { act: "create", fields: { title: extracted.title, span, place: extracted.place } };
  }
  if (extracted.cancelled) return { act: "cancel", fields: {} };
  const fields: Record<string, unknown> = {};
  if (extracted.title !== null) fields.title = extracted.title;
  if (extracted.place !== null) fields.place = extracted.place;
  const moved = date !== null || extracted.startTime !== null;
  if (moved) fields.span = span;
  return changeUnlessEmpty(moved ? "move" : "change", fields, rejection);
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
  const day = resolveDay(input.date, knownSpan, timeZone);
  if (!day) return null;
  const startTime = resolveStartTime(input.start, knownSpan, timeZone);
  if (startTime === null) return allDaySpan(day, knownSpan);
  return timedSpan(day, startTime, input.end, knownSpan, timeZone);
}

function resolveDay(date: LocalDate | null, knownSpan: TimeSpan | null, timeZone: string): LocalDate | null {
  return date ?? (knownSpan ? (knownSpan.allDay ? knownSpan.firstDay : localDateTime(knownSpan.start, timeZone).date) : null);
}

function resolveStartTime(start: string | null, knownSpan: TimeSpan | null, timeZone: string): string | null {
  return start ?? (knownSpan && !knownSpan.allDay ? localDateTime(knownSpan.start, timeZone).time : null);
}

function allDaySpan(day: LocalDate, knownSpan: TimeSpan | null): Record<string, unknown> {
  const length = knownSpan?.allDay ? daysBetween(knownSpan.firstDay, knownSpan.lastDay) : 0;
  return { allDay: true, firstDay: day, lastDay: addDays(day, length) };
}

function timedSpan(day: LocalDate, startTime: string, endTime: string | null, knownSpan: TimeSpan | null, timeZone: string): Record<string, unknown> | null {
  const start = instantAt(day, startTime, timeZone);
  const end = start && endInstantOf(day, start, endTime, knownSpan, timeZone);
  if (!start || !end) return null;
  return { allDay: false, start: start.toISOString(), end: end.toISOString() };
}

function endInstantOf(day: LocalDate, start: Date, endTime: string | null, knownSpan: TimeSpan | null, timeZone: string): Date | null {
  if (endTime !== null) {
    const end = instantAt(day, endTime, timeZone);
    // An end before the start is on the next day, as for a sleepover.
    return end && end < start ? instantAt(addDays(day, 1), endTime, timeZone) : end;
  }
  if (knownSpan && !knownSpan.allDay) return new Date(start.getTime() + (knownSpan.end.getTime() - knownSpan.start.getTime()));
  return start;
}

function daysBetween(first: LocalDate, last: LocalDate): number {
  return Math.round((new Date(`${last}T00:00:00Z`).getTime() - new Date(`${first}T00:00:00Z`).getTime()) / 86_400_000);
}
