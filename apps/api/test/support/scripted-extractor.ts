import type {
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
    updates: null,
    cancelled: false,
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
  return { updates: null, cancelled: false, title: null, bring: [], ...rest, deadline: { ...noDate, ...deadline } };
}

/**
 * Answers with the canned output for the first script whose text the message contains, and with
 * no Items for any other message. Reads the words of page images a `FakeTextExtractor` rendered.
 * Remembers every request.
 */
export class ScriptedExtractor implements Extractor {
  readonly requests: ExtractionRequest[] = [];
  private readonly scripts: { contains: string; result: ExtractionResult }[] = [];

  /** The Events and Tasks a message containing `contains` yields. */
  script(contains: string, events: ExtractedEvent[], tasks: ExtractedTask[] = []): void {
    this.scripts.unshift({ contains, result: { ok: true, events, tasks } });
  }

  /** Makes the endpoint fail for every message, until scripted again. */
  fail(problem: Extract<ExtractionResult, { ok: false }>["problem"]): void {
    this.scripts.unshift({ contains: "", result: { ok: false, problem, message: `the endpoint is ${problem}` } });
  }

  recover(): void {
    const failing = this.scripts.findIndex((script) => script.contains === "");
    if (failing >= 0) this.scripts.splice(failing, 1);
  }

  extract(request: ExtractionRequest): Promise<ExtractionResult> {
    this.requests.push(request);
    const script = this.scripts.find(({ contains }) => request.message.text.includes(contains));
    return Promise.resolve(script?.result ?? { ok: true, events: [], tasks: [] });
  }
}
