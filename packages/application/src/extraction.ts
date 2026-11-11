import {
  addDays,
  eventOf,
  instantAt,
  localDateTime,
  problemsWithEventFields,
  problemsWithTaskFields,
  quoteFoundIn,
  resolveDate,
  resolveDeadline,
  taskOf,
  weekdayOf,
  type LocalDate,
  type RawMessageId,
  type SourceId,
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
  LlmEndpoint,
  LlmEndpointRepository,
  NewItem,
  OcrModelStore,
  PendingAttachment,
  PendingMessage,
  SecretStore,
  TextExtractor,
} from "./ports";

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
  /** What failed an automatic check when a message was read a second time, and is not written. */
  dropped: { messageId: RawMessageId; title: string | null; problem: string }[];
  /** The messages that wait for the next run. */
  failed: { messageId: RawMessageId; problem: Extract<ExtractionResult, { ok: false }>["problem"]; message: string }[];
};

/** How many messages one run extracts at most, so that a run stays short. */
const batchSize = 20;

/**
 * Extraction of Items from raw messages (ADR-0005): once per message, through the Family's LLM
 * endpoint. The model only reads; code resolves dates against the send time and checks what the
 * message says. An Item failing a check has the message read once more; failing again, it is
 * not written.
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

  async function read(message: PendingMessage, text: string, endpoint: LlmEndpoint): Promise<ExtractionResult> {
    const sent = localDateTime(message.sentAt, timeZone);
    return extractor.extract({ endpoint, message: { text, sent: { ...sent, weekday: weekdayOf(sent.date) } } });
  }

  async function extractOne(message: PendingMessage, text: string, problems: AttachmentProblem[], endpoint: LlmEndpoint) {
    const reading: Reading = { text, sentOn: localDateTime(message.sentAt, timeZone).date, timeZone };
    let result = await read(message, text, endpoint);
    if (!result.ok) return { result, dropped: [] };
    let checkedItems = checkAll(result, reading);
    if (checkedItems.failing.length > 0) {
      result = await read(message, text, endpoint);
      if (!result.ok) return { result, dropped: [] };
      checkedItems = checkAll(result, reading);
    }
    await items.recordExtraction({ messageId: message.id, at: clock.now(), items: checkedItems.passing, attachmentProblems: problems });
    return { result, dropped: checkedItems.failing.map((failing) => ({ messageId: message.id, ...failing })) };
  }

  /** Extracts one message; the failure, if it failed. */
  async function extractMessage(message: PendingMessage, endpoint: LlmEndpoint, report: ExtractionReport): Promise<ExtractionReport["failed"][number] | null> {
    const full = await fullTextOf(message, message.body);
    const { result, dropped } = await extractOne(message, full.text, full.problems, endpoint);
    report.dropped.push(...dropped);
    return result.ok ? null : { messageId: message.id, problem: result.problem, message: result.message };
  }

  return {
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
      const report: ExtractionReport = { extracted: [], dropped: [], failed: [] };
      const endpoint = await llmEndpointOf(deps);
      if (!endpoint) return report;
      const pending = await items.pendingMessages(batchSize);
      if (pending.length === 0) return report;
      const progress = await activity.begin("extracting", pending.length);
      try {
        for (const message of pending) {
          const failure = await extractMessage(message, endpoint, report);
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

type Reading = { text: string; sentOn: LocalDate; timeZone: string };

type Checked = { passing: NewItem[]; failing: { title: string | null; problem: string }[] };

/** The Items a reading states, each checked: written if it passes, else only reported. */
function checkAll(result: Extract<ExtractionResult, { ok: true }>, reading: Reading): Checked {
  const checked: Checked = { passing: [], failing: [] };
  for (const outcome of [...result.events.map((event) => eventItemOf(event, reading)), ...result.tasks.map((task) => taskItemOf(task, reading))]) {
    if ("problem" in outcome) checked.failing.push(outcome);
    else checked.passing.push(outcome);
  }
  return checked;
}

type Outcome = NewItem | { title: string | null; problem: string };

/** Whether any part of a date the model read is stated. */
const mentions = (date: ExtractedEvent["date"]) => Object.values(date).some((part) => part !== null);

/** The date the message states, unless it does not quote the Item, or the date cannot be resolved or has the wrong weekday. */
function eventDate(extracted: ExtractedEvent, reading: Reading): { date: LocalDate } | { problem: string } {
  if (!quoteFoundIn(extracted.evidence, reading.text)) return { problem: "evidence-not-found" };
  if (!mentions(extracted.date)) return { problem: "no-date" };
  const resolved = resolveDate(extracted.date, reading.sentOn);
  return resolved.ok ? { date: resolved.date } : { problem: resolved.problem };
}

/** The Deadline the message states, or none; unless it does not quote the Task, or the Deadline cannot be resolved. */
function taskDeadline(extracted: ExtractedTask, reading: Reading): { deadline: LocalDate | null } | { problem: string } {
  if (!quoteFoundIn(extracted.evidence, reading.text)) return { problem: "evidence-not-found" };
  if (!mentions(extracted.deadline)) return { deadline: null };
  const resolved = resolveDeadline(extracted.deadline, reading.sentOn);
  return resolved.ok ? { deadline: resolved.date } : { problem: resolved.problem };
}

/** The Event an extracted one is, if its message says it and its fields can be an Event's. */
function eventItemOf(extracted: ExtractedEvent, reading: Reading): Outcome {
  const { title } = extracted;
  const date = eventDate(extracted, reading);
  if ("problem" in date) return { title, problem: date.problem };
  const fields = { title, span: spanOf(date.date, extracted.startTime, extracted.endTime, reading.timeZone), place: extracted.place };
  const event = problemsWithEventFields(fields).length === 0 ? eventOf({ fields, cancelled: false }) : null;
  return event ? { kind: "event", event } : { title, problem: "invalid-fields" };
}

/** The Task an extracted one is, if its message says it; a Task without a Deadline is due at once. */
function taskItemOf(extracted: ExtractedTask, reading: Reading): Outcome {
  const { title } = extracted;
  const deadline = taskDeadline(extracted, reading);
  if ("problem" in deadline) return { title, problem: deadline.problem };
  const fields = { title, deadline: deadline.deadline, // A model may answer an empty text for no description.
  description: extracted.description?.trim() || null };
  const task = problemsWithTaskFields(fields).length === 0 ? taskOf({ fields, cancelled: false }) : null;
  return task ? { kind: "task", task } : { title, problem: "invalid-fields" };
}

/** The span of an Event on its date, as JSON: at the stated times, or all day without any. */
function spanOf(day: LocalDate, start: string | null, end: string | null, timeZone: string): Record<string, unknown> | null {
  if (start === null) return { allDay: true, firstDay: day, lastDay: day };
  const from = instantAt(day, start, timeZone);
  const until = from && endOf(day, from, end, timeZone);
  return from && until ? { allDay: false, start: from.toISOString(), end: until.toISOString() } : null;
}

/** When an Event ends: without an end it has no duration; an end before the start is on the next day, as for a sleepover. */
function endOf(day: LocalDate, start: Date, end: string | null, timeZone: string): Date | null {
  if (end === null) return start;
  const sameDay = instantAt(day, end, timeZone);
  return sameDay && sameDay < start ? instantAt(addDays(day, 1), end, timeZone) : sameDay;
}
