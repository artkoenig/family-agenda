import {
  weekdays,
  type DateMention,
  type Weekday,
} from "@family-agenda/domain";
import type {
  EndpointFailure,
  EndpointCheck,
  ExtractedEvent,
  ExtractedTask,
  ExtractionRequest,
  ExtractionResult,
  Extractor,
  LlmEndpoint,
} from "@family-agenda/application";

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
  required: ["events", "tasks"],
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "date", "startTime", "endTime", "place", "evidence"],
        properties: {
          title: nullable("string"),
          date: dateMentionSchema,
          startTime: nullable("string"),
          endTime: nullable("string"),
          place: nullable("string"),
          evidence: { type: "string" },
        },
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "deadline", "bring", "evidence"],
        properties: {
          title: nullable("string"),
          deadline: dateMentionSchema,
          bring: { type: "array", items: { type: "string" } },
          evidence: { type: "string" },
        },
      },
    },
  },
};

const instructions = `You read messages a family receives, such as school mails, and list what happens on a date and what someone has to do or bring.

"events" are what happens on a date and matters to the family: appointments someone attends, such as a parents' evening, a school trip or a match; days without school, such as a study day, a teachers' training day or a bridge day; and what takes place at school, such as a bike check by the police or a project day.
"tasks" are things someone has to do or bring, such as signing a form, paying for a trip, filling in a survey or bringing sports kit, optionally by a deadline.

Rules:
- List every such event and task, each once, also when a long newsletter mentions it in passing. List nothing for a message that names no date and nothing to do; then "events" and "tasks" are empty.
- A list of things to bring for one occasion is one task, with the things in "bring", each as written. "bring" is empty for a task that is not about bringing things.
- Do not list changes to single lessons, such as a cancelled or substituted lesson. A whole day without school is an event.
- The message may be followed by the text of its attachments, each after a line "Attachment <file name>:". Read them as part of the message.
- "evidence" is the shortest passage of the message that states the event or task and its date, copied character for character. Never rephrase, translate or shorten words inside it.
- "title" is short, in the language of the message, without the date.
- Never compute dates. Fill in only the date parts the message states, and leave the others null:
  - "day", "month", "year" as written ("year" null if the message gives none);
  - "weekday" in English lower case if the message names one, such as "monday";
  - "daysAfter" for a date relative to the day the message was sent: 0 for today, 1 for tomorrow, 2 for the day after tomorrow, 14 for "in two weeks";
  - "weeksAfter" with a weekday alone: 0 for this week, 1 for next week; null if the message only names the weekday.
- When the evidence states a date, its parts are never all null: for "Donnerstag, 19. November 2026" they are day 19, month 11, year 2026 and weekday "thursday".
- A task's "deadline" is the date by which it must be done; every part is null if the message gives none. For a month alone, as in "bis Ende November 2026", fill in "month" and "year" and leave "day" null.
- "startTime" and "endTime" as HH:MM in 24-hour time, or null.
- "place" as written, or null.
- Do not list an event or task the message says is cancelled.`;

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
    const answer = await this.complete(request.endpoint, {
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: promptOf(request) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "items", strict: true, schema: extractionSchema },
      },
    });
    if (!answer.ok) return answer;
    let output: unknown;
    try {
      output = JSON.parse(answer.content);
    } catch {
      return { ok: false, problem: "invalid-output", message: "The answer is no JSON." };
    }
    const events = eventsOf(output);
    const tasks = tasksOf(output);
    if (!events || !tasks) return { ok: false, problem: "invalid-output", message: "The answer does not fit the schema." };
    return { ok: true, events, tasks };
  }

  /** What `GET /models` answers: the ids of the models, or why it could not be asked. */
  async check(endpoint: LlmEndpoint): Promise<EndpointCheck> {
    try {
      const response = await fetch(`${endpoint.baseUrl}/models`, {
        headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: `The LLM endpoint refused the API key (HTTP ${response.status}).` };
      }
      if (!response.ok) {
        return { ok: false, message: `The LLM endpoint answered with HTTP ${response.status}.` };
      }
      return { ok: true, models: modelIdsOf(await response.json().catch(() => null)) };
    } catch (error) {
      return { ok: false, message: `The LLM endpoint could not be reached: ${reason(error)}` };
    }
  }

  /** The text of a chat completion, complete and not cut off at the token limit. */
  private async complete(
    endpoint: LlmEndpoint,
    body: object,
  ): Promise<{ ok: true; content: string } | EndpointFailure> {
    let response: Response;
    try {
      response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
        },
        // A reasoning model left to its default may think for minutes about one short mail.
        body: JSON.stringify({ model: endpoint.model, reasoning_effort: "low", ...body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { ok: false, problem: "unreachable", message: `The LLM endpoint could not be reached: ${reason(error)}` };
    }
    const statusProblem = statusProblemOf(response);
    if (statusProblem) return statusProblem;
    let answer: unknown;
    try {
      answer = await response.json();
    } catch (error) {
      return { ok: false, problem: "unreachable", message: `The LLM endpoint answered with no JSON: ${reason(error)}` };
    }
    return contentOf(answer);
  }
}

/** The sorted ids in a `GET /models` answer, `{ data: [{ id }] }`; none if it looks otherwise. */
function modelIdsOf(answer: unknown): string[] {
  const data = (answer as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids = data.flatMap((entry: unknown) => {
    const id = (entry as { id?: unknown } | null)?.id;
    return typeof id === "string" && id !== "" ? [id] : [];
  });
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function promptOf(request: ExtractionRequest): string {
  const { message } = request;
  return [
    `The message was sent on ${message.sent.weekday}, ${message.sent.date} at ${message.sent.time}.`,
    "",
    "The message:",
    "<<<",
    message.text,
    ">>>",
  ].join("\n");
}

/** The problem a non-2xx HTTP status means, or null if the request was accepted. */
function statusProblemOf(response: Response): EndpointFailure | null {
  if (response.status === 401 || response.status === 403) {
    return { ok: false, problem: "unauthorized", message: `The LLM endpoint refused the API key (HTTP ${response.status}).` };
  }
  if (!response.ok) {
    // A request the endpoint cannot handle, such as an unknown model, fails every message alike.
    return { ok: false, problem: "unreachable", message: `The LLM endpoint answered with HTTP ${response.status}.` };
  }
  return null;
}

/** The answer's content, or the problem if it does not fit the schema. */
function contentOf(answer: unknown): { ok: true; content: string } | EndpointFailure {
  const choice = (answer as { choices?: { finish_reason?: string; message?: { content?: unknown } }[] }).choices?.[0];
  if (typeof choice?.message?.content !== "string") {
    return { ok: false, problem: "invalid-output", message: "The LLM endpoint answered without a message." };
  }
  if (choice.finish_reason === "length") {
    return { ok: false, problem: "invalid-output", message: "The answer was cut off at the token limit." };
  }
  return { ok: true, content: choice.message.content };
}

/** The events of an answer, or null if it does not fit the schema. */
function eventsOf(output: unknown): ExtractedEvent[] | null {
  if (!isObject(output) || !Array.isArray(output.events)) return null;
  const events: ExtractedEvent[] = [];
  for (const raw of output.events) {
    const event = eventOf(raw);
    if (event === null) return null;
    events.push(event);
  }
  return events;
}

function eventOf(raw: unknown): ExtractedEvent | null {
  if (!isObject(raw) || !isObject(raw.date)) return null;
  const date = dateOf(raw.date);
  if (
    !date ||
    typeof raw.evidence !== "string" ||
    ![raw.title, raw.startTime, raw.endTime, raw.place].every(isTextOrNull)
  ) {
    return null;
  }
  return {
    title: raw.title as string | null,
    date,
    startTime: raw.startTime as string | null,
    endTime: raw.endTime as string | null,
    place: raw.place as string | null,
    evidence: raw.evidence,
  };
}

/** The tasks of an answer, or null if it does not fit the schema. */
function tasksOf(output: unknown): ExtractedTask[] | null {
  if (!isObject(output) || !Array.isArray(output.tasks)) return null;
  const tasks: ExtractedTask[] = [];
  for (const raw of output.tasks) {
    const task = taskOf(raw);
    if (task === null) return null;
    tasks.push(task);
  }
  return tasks;
}

function taskOf(raw: unknown): ExtractedTask | null {
  if (!isObject(raw) || !isObject(raw.deadline) || !Array.isArray(raw.bring)) return null;
  const deadline = dateOf(raw.deadline);
  const bring: unknown[] = raw.bring;
  if (!validTaskFields(deadline, raw, bring)) return null;
  return {
    title: raw.title as string | null,
    deadline: deadline as DateMention,
    bring: bring as string[],
    evidence: raw.evidence as string,
  };
}

function validTaskFields(
  deadline: DateMention | null,
  raw: Record<string, unknown>,
  bring: unknown[],
): boolean {
  if (deadline === null) return false;
  if (typeof raw.evidence !== "string") return false;
  return isTextOrNull(raw.title) && bring.every((thing) => typeof thing === "string");
}

function wholeOf(value: unknown): number | null | undefined {
  return value === null || value === undefined ? null : Number.isInteger(value) ? (value as number) : undefined;
}

function dateOf(raw: Record<string, unknown>): DateMention | null {
  const day = wholeOf(raw.day);
  const month = wholeOf(raw.month);
  const year = wholeOf(raw.year);
  const daysAfter = wholeOf(raw.daysAfter);
  const weeksAfter = wholeOf(raw.weeksAfter);
  const weekday = raw.weekday ?? null;
  if (![day, month, year, daysAfter, weeksAfter].every((value) => value !== undefined)) return null;
  if (!validWeekday(weekday)) return null;
  return {
    day: nullIfUndefined(day),
    month: nullIfUndefined(month),
    year: nullIfUndefined(year),
    weekday: weekday as Weekday | null,
    daysAfter: nullIfUndefined(daysAfter),
    weeksAfter: nullIfUndefined(weeksAfter),
  };
}

function nullIfUndefined(value: number | null | undefined): number | null {
  return value ?? null;
}

function validWeekday(weekday: unknown): boolean {
  return weekday === null || (weekdays as readonly unknown[]).includes(weekday);
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
