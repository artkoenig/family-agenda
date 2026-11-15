import type { ExtractionAccess, ExtractionReport } from "./extraction";
import type { RunReport, SourcePolling } from "./polling";

/** What one step of due work came to: its report, or the error it stopped with. */
export type StepOutcome<R> = { ok: true; report: R } | { ok: false; error: unknown };

/** What one run of due work did: the Sources it ran, then the messages it extracted. */
export type DueWorkReport = { polled: StepOutcome<RunReport>; extracted: StepOutcome<ExtractionReport> };

async function outcomeOf<R>(step: () => Promise<R>): Promise<StepOutcome<R>> {
  try {
    return { ok: true, report: await step() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * The worker's due work as one operation that runs once and ends: the Sources whose polling
 * interval has passed, then Extraction of the messages they and earlier runs brought in, which
 * runs even when polling failed.
 */
export function createDueWork(deps: { polling: SourcePolling; extraction: ExtractionAccess }) {
  const { polling, extraction } = deps;
  return {
    async run(): Promise<DueWorkReport> {
      const polled = await outcomeOf(() => polling.pollDue());
      const extracted = await outcomeOf(() => extraction.extractPending());
      return { polled, extracted };
    },
  };
}

export type DueWork = ReturnType<typeof createDueWork>;
