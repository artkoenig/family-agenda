import type {
  EndpointHealth,
  ExtractedEvent,
  ExtractedTask,
  ExtractionRequest,
  ExtractionResult,
  Extractor,
} from "@family-agenda/application";
import type { DateMention } from "@family-agenda/domain";

const noDate = { day: null, month: null, year: null, weekday: null, daysAfter: null, weeksAfter: null };

/** An Event as a model reads it from a message; unstated parts are null. */
export function extracted(
  event: Partial<Omit<ExtractedEvent, "date">> & Pick<ExtractedEvent, "evidence"> & { date?: Partial<DateMention> },
): ExtractedEvent {
  const { date, ...rest } = event;
  return {
    title: null,
    startTime: null,
    endTime: null,
    place: null,
    ...rest,
    date: { ...noDate, ...date },
  };
}

/** A Task as a model reads it from a message; unstated parts are null or empty. */
export function extractedTask(
  task: Partial<Omit<ExtractedTask, "deadline">> & Pick<ExtractedTask, "evidence"> & { deadline?: Partial<DateMention> },
): ExtractedTask {
  const { deadline, ...rest } = task;
  return { title: null, bring: [], ...rest, deadline: { ...noDate, ...deadline } };
}

/**
 * Answers with the canned output for the first script whose text the message contains, and with
 * no Items for any other message. Reads the words of page images a `FakeTextExtractor` rendered.
 * Remembers every request.
 */
export class ScriptedExtractor implements Extractor {
  readonly requests: ExtractionRequest[] = [];
  private readonly scripts: { contains: string; result: ExtractionResult; then?: ExtractionResult[] }[] = [];
  private healthResult: EndpointHealth = { ok: true };
  private offeredModels: string[] = [];

  /** The Events and Tasks a message containing `contains` yields. */
  script(contains: string, events: ExtractedEvent[], tasks: ExtractedTask[] = []): void {
    this.scripts.unshift({ contains, result: { ok: true, events, tasks } });
  }

  /** What a message containing `contains` yields on each reading in turn; the last one stays. */
  scriptReadings(contains: string, readings: { events: ExtractedEvent[]; tasks?: ExtractedTask[] }[]): void {
    const [first, ...then] = readings.map(({ events, tasks = [] }): ExtractionResult => ({ ok: true, events, tasks }));
    if (first) this.scripts.unshift({ contains, result: first, then });
  }

  /** Makes the endpoint fail for every message, until scripted again. */
  fail(problem: Extract<ExtractionResult, { ok: false }>["problem"]): void {
    this.scripts.unshift({ contains: "", result: { ok: false, problem, message: `the endpoint is ${problem}` } });
  }

  recover(): void {
    const failing = this.scripts.findIndex((script) => script.contains === "");
    if (failing >= 0) this.scripts.splice(failing, 1);
  }

  /** Makes the health check report a problem, until recovered. */
  failHealth(message: string): void {
    this.healthResult = { ok: false, message };
  }

  /** The models the endpoint offers. */
  offerModels(...models: string[]): void {
    this.offeredModels = models;
  }

  recoverHealth(): void {
    this.healthResult = { ok: true };
  }

  extract(request: ExtractionRequest): Promise<ExtractionResult> {
    this.requests.push(request);
    const script = this.scripts.find(({ contains }) => request.message.text.includes(contains));
    const result = script?.result ?? { ok: true, events: [], tasks: [] };
    const next = script?.then?.shift();
    if (script && next) script.result = next;
    return Promise.resolve(result);
  }

  health(): Promise<EndpointHealth> {
    return Promise.resolve(this.healthResult);
  }

  models(): Promise<string[]> {
    return Promise.resolve(this.offeredModels);
  }
}
