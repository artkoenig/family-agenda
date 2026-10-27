import {
  weekdays,
  type DateMention,
  type Weekday,
} from "@family-butler/domain";
import type { ExtractedEvent, ExtractionRequest, ExtractionResult, Extractor } from "@family-butler/application";

export type OpenAiCompatibleExtractorOptions = {
  /** How long the endpoint may take to answer; a local model on a CPU is slow. */
  timeoutMs?: number;
};

const nullable = (type: string) => ({ type: [type, "null"] });

const dateMentionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["day", "month", "year", "weekday", "daysAfter", "weeksAfter"],
  properties: {
    day: nullable("integer"),
    month: nullable("integer"),
    year: nullable("integer"),
    weekday: { type: ["string", "null"], enum: [...weekdays, null] },
    daysAfter: nullable("integer"),
    weeksAfter: nullable("integer"),
  },
};

/**
 * The output schema, in the subset every OpenAI-compatible runtime accepts: flat, every field
 * required and nullable, no formats, lengths or numeric bounds, and `additionalProperties: false`.
 */
export const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["updates", "cancelled", "title", "date", "startTime", "endTime", "place", "evidence"],
        properties: {
          updates: nullable("string"),
          cancelled: { type: "boolean" },
          title: nullable("string"),
          date: dateMentionSchema,
          startTime: nullable("string"),
          endTime: nullable("string"),
          place: nullable("string"),
          evidence: { type: "string" },
        },
      },
    },
  },
};

const instructions = `You read messages a family receives, such as school mails, and list the events in them that someone has to attend: appointments with a date, such as a parents' evening, a school trip or a match.

Rules:
- List every such event, each once. List nothing for a message that only informs and has nothing to attend; then "events" is empty.
- Do not list deadlines, things to do or bring, or timetable changes; only events.
- "evidence" is the shortest passage of the message that states the event and its date, copied character for character. Never rephrase, translate or shorten words inside it.
- "title" is short, in the language of the message, without the date.
- Never compute dates. Fill in only the date parts the message states, and leave the others null:
  - "day", "month", "year" as written ("year" null if the message gives none);
  - "weekday" in English lower case if the message names one, such as "monday";
  - "daysAfter" for a date relative to the day the message was sent: 0 for today, 1 for tomorrow, 2 for the day after tomorrow, 14 for "in two weeks";
  - "weeksAfter" with a weekday alone: 0 for this week, 1 for next week; null if the message only names the weekday.
- "startTime" and "endTime" as HH:MM in 24-hour time, or null.
- "place" as written, or null.
- When the message changes, moves or cancels one of the known events listed below, set "updates" to its id (such as "E1"), "cancelled" to true for a cancellation, and fill in only what changes: "title" null unless it is renamed, a new date or times if it moves. Otherwise "updates" is null and "cancelled" false.`;

/**
 * The `Extractor` for any OpenAI-compatible server, such as Ollama, llama.cpp, vLLM, LM Studio,
 * OpenAI or Mistral: one chat completion per message with JSON-schema structured output, and the
 * answer checked against the schema here, since some runtimes skip parts of it silently.
 */
export class OpenAiCompatibleExtractor implements Extractor {
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleExtractorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const { endpoint } = request;
    let response: Response;
    try {
      response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: endpoint.model,
          messages: [
            { role: "system", content: instructions },
            { role: "user", content: promptOf(request) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "events", strict: true, schema: extractionSchema },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { ok: false, problem: "unreachable", message: `The LLM endpoint could not be reached: ${reason(error)}` };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, problem: "unauthorized", message: `The LLM endpoint refused the API key (HTTP ${response.status}).` };
    }
    if (!response.ok) {
      // A request the endpoint cannot handle, such as an unknown model, fails every message alike.
      return { ok: false, problem: "unreachable", message: `The LLM endpoint answered with HTTP ${response.status}.` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return { ok: false, problem: "unreachable", message: `The LLM endpoint answered with no JSON: ${reason(error)}` };
    }
    const choice = (body as { choices?: { finish_reason?: string; message?: { content?: unknown } }[] }).choices?.[0];
    if (typeof choice?.message?.content !== "string") {
      return { ok: false, problem: "invalid-output", message: "The LLM endpoint answered without a message." };
    }
    if (choice.finish_reason === "length") {
      return { ok: false, problem: "invalid-output", message: "The answer was cut off at the token limit." };
    }
    let output: unknown;
    try {
      output = JSON.parse(choice.message.content);
    } catch {
      return { ok: false, problem: "invalid-output", message: "The answer is no JSON." };
    }
    const events = eventsOf(output);
    if (!events) return { ok: false, problem: "invalid-output", message: "The answer does not fit the schema." };
    return { ok: true, events };
  }
}

function promptOf(request: ExtractionRequest): string {
  const { message, knownEvents } = request;
  const known =
    knownEvents.length === 0
      ? "None."
      : knownEvents
          .map((event) => `- ${event.ref}: ${event.title}, ${event.when}${event.place ? `, ${event.place}` : ""}`)
          .join("\n");
  return [
    `The message was sent on ${message.sent.weekday}, ${message.sent.date} at ${message.sent.time}.`,
    "",
    "Known events from earlier messages of its conversation:",
    known,
    "",
    "The message:",
    "<<<",
    message.text,
    ">>>",
  ].join("\n");
}

/** The events of an answer, or null if it does not fit the schema. */
function eventsOf(output: unknown): ExtractedEvent[] | null {
  if (!isObject(output) || !Array.isArray(output.events)) return null;
  const events: ExtractedEvent[] = [];
  for (const raw of output.events) {
    if (!isObject(raw) || !isObject(raw.date)) return null;
    const date = dateOf(raw.date);
    if (
      !date ||
      typeof raw.cancelled !== "boolean" ||
      typeof raw.evidence !== "string" ||
      ![raw.updates, raw.title, raw.startTime, raw.endTime, raw.place].every(isTextOrNull)
    ) {
      return null;
    }
    events.push({
      updates: raw.updates as string | null,
      cancelled: raw.cancelled,
      title: raw.title as string | null,
      date,
      startTime: raw.startTime as string | null,
      endTime: raw.endTime as string | null,
      place: raw.place as string | null,
      evidence: raw.evidence,
    });
  }
  return events;
}

function dateOf(raw: Record<string, unknown>): DateMention | null {
  const whole = (value: unknown) => (value === null || value === undefined ? null : Number.isInteger(value) ? (value as number) : undefined);
  const day = whole(raw.day);
  const month = whole(raw.month);
  const year = whole(raw.year);
  const daysAfter = whole(raw.daysAfter);
  const weeksAfter = whole(raw.weeksAfter);
  const weekday = raw.weekday ?? null;
  if ([day, month, year, daysAfter, weeksAfter].includes(undefined)) return null;
  if (weekday !== null && !(weekdays as readonly unknown[]).includes(weekday)) return null;
  return {
    day: day ?? null,
    month: month ?? null,
    year: year ?? null,
    weekday: weekday as Weekday | null,
    daysAfter: daysAfter ?? null,
    weeksAfter: weeksAfter ?? null,
  };
}

function isTextOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
