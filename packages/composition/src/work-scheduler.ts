import { maximumSleepMs, type DueWorkReport } from "@family-agenda/application";
import type { WorkerClient } from "./worker-channel";
import type { FamilyDatabase } from "./worker-service";

/** Where the scheduler reports what went wrong; the process decides where that goes. */
export type WorkerLog = { warn(message: string): void; error(message: string, error?: unknown): void };

const joined = (items: string[]) => items.join(", ");

/** The warnings a polling report holds. */
function pollingWarnings(report: NonNullable<DueWorkReport["polling"]>): string[] {
  return [
    ...report.failed.map((failure) => `Source ${failure.sourceId} failed (${failure.kind}): ${failure.message}`),
    ...report.refused.map((refusal) => `Source ${refusal.sourceId} named Source Attributes it never declared or had archived, so those records are refused: ${joined(refusal.attributes)}`),
    ...report.invalid.map((record) => `Source ${record.sourceId} states an invalid Item for ${record.externalId}, which is not written: ${record.problems.join("; ")}`),
  ];
}

/** The warnings an extraction report holds. */
function extractionWarnings(report: NonNullable<DueWorkReport["extraction"]>): string[] {
  return [
    ...report.failed.map((failure) => `Extracting message ${failure.messageId} failed (${failure.problem}): ${failure.message}`),
    ...report.dropped.map((dropped) => `An Item "${dropped.title ?? ""}" of message ${dropped.messageId} failed a check twice and is not written: ${dropped.problem}`),
  ];
}

/** Logs what a round of due work did: what threw, failed, was refused or dropped. */
export function logDueWorkReport(report: DueWorkReport, log: WorkerLog): void {
  for (const { step, error } of report.errors) {
    log.error(step === "polling" ? "Polling Sources failed:" : "Extracting messages failed:", error);
  }
  const warnings = [...(report.polling ? pollingWarnings(report.polling) : []), ...(report.extraction ? extractionWarnings(report.extraction) : [])];
  for (const warning of warnings) log.warn(warning);
}

/** How often messages past their retention are deleted and secrets nothing refers to swept. */
export const cleanupTickMs = 24 * 60 * 60 * 1000;

export type WorkSchedulerDeps = {
  worker: Pick<WorkerClient, "poll" | "extract" | "cleanup">;
  family: FamilyDatabase;
  log: WorkerLog;
  now?: () => number;
};

export type WorkScheduler = {
  /** One round: polls, then extracts, as the worker answers; how long to wait before the next. */
  round(): Promise<number>;
  /** Triggers the cleanup. */
  cleanup(): Promise<void>;
  /** Runs rounds and cleans up until `stop`. */
  start(): void;
  /** Ends the timers and waits for the calls in flight. */
  stop(): Promise<void>;
};

/**
 * The schedule of a Family's background work, kept by api: it triggers the worker, which holds no
 * schedule of its own, when work is due, and sleeps until the worker says work is next due.
 */
export function createWorkScheduler(deps: WorkSchedulerDeps): WorkScheduler {
  const { worker, family, log } = deps;
  const now = deps.now ?? Date.now;
  const stopping = new AbortController();
  const isStopping = () => stopping.signal.aborted;
  let wake = () => {};
  let working: Promise<void> = Promise.resolve();
  const timers: NodeJS.Timeout[] = [];

  const sleepUntil = (next: Date | null) => (next ? Math.min(maximumSleepMs, Math.max(0, next.getTime() - now())) : maximumSleepMs);

  const round = async (): Promise<number> => {
    const report: DueWorkReport = { polling: null, extraction: null, errors: [] };
    let next: Date | null = null;
    let failed = false;
    try {
      report.polling = (await worker.poll(family)).report;
    } catch (error) {
      report.errors.push({ step: "polling", error });
      failed = true;
    }
    try {
      const extracted = await worker.extract(family);
      report.extraction = extracted.report;
      next = extracted.nextDueAt;
    } catch (error) {
      report.errors.push({ step: "extraction", error });
      failed = true;
    }
    logDueWorkReport(report, log);
    // A worker that failed is asked again soon, not at once.
    return failed ? maximumSleepMs : sleepUntil(next);
  };

  const cleanup = () =>
    worker.cleanup(family).then(
      () => undefined,
      (error: unknown) => {
        log.error("Cleaning up (retention, secrets nothing refers to) failed:", error);
      },
    );

  const loop = async () => {
    while (!isStopping()) {
      const sleepMs = await round();
      if (isStopping()) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, sleepMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  };

  return {
    round,
    cleanup,
    start() {
      void cleanup();
      timers.push(setInterval(() => void cleanup(), cleanupTickMs));
      working = loop();
    },
    async stop() {
      stopping.abort();
      wake();
      for (const timer of timers) clearInterval(timer);
      await working;
    },
  };
}
