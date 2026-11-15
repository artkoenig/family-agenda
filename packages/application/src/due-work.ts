import type { ExtractionAccess, ExtractionReport } from "./extraction";
import type { RunReport, SourcePolling } from "./polling";

/** What one run of due work did: the Sources it ran, then the messages it extracted. */
export type DueWorkReport = { polled: RunReport; extracted: ExtractionReport };

/**
 * The worker's due work as one operation that runs once and ends: the Sources whose polling
 * interval has passed, then Extraction of the messages they and earlier runs brought in.
 */
export function createDueWork(deps: { polling: SourcePolling; extraction: ExtractionAccess }) {
  const { polling, extraction } = deps;
  return {
    async run(): Promise<DueWorkReport> {
      const polled = await polling.pollDue();
      const extracted = await extraction.extractPending();
      return { polled, extracted };
    },
  };
}

export type DueWork = ReturnType<typeof createDueWork>;
