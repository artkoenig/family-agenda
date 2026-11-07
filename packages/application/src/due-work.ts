import type { ExtractionAccess, ExtractionReport } from "./extraction";
import type { PollReport, SourcePolling } from "./polling";
import type { Clock } from "./ports";
import type { Retention } from "./retention";
import type { SecretSweep } from "./secret-sweep";

export type DueWorkDeps = { clock: Clock; polling: SourcePolling; extraction: ExtractionAccess };

/** What one round did; a step that threw has no report but an error. */
export type DueWorkReport = {
  polling: PollReport | null;
  extraction: ExtractionReport | null;
  errors: { step: "polling" | "extraction"; error: unknown }[];
};

/** The longest a scheduler sleeps between rounds, so that what an Admin changes is noticed soon. */
export const maximumSleepMs = 15_000;

/**
 * The work an Instance does when it is due (polling the Sources, then extracting their messages),
 * as functions a scheduler calls. Nothing here sleeps or loops.
 */
export function createDueWork(deps: DueWorkDeps) {
  const { clock, polling, extraction } = deps;
  let running: Promise<DueWorkReport> | null = null;

  async function round(): Promise<DueWorkReport> {
    const report: DueWorkReport = { polling: null, extraction: null, errors: [] };
    try {
      report.polling = await polling.pollDue();
    } catch (error) {
      report.errors.push({ step: "polling", error });
    }
    // Then the messages the Sources brought in, each once.
    try {
      report.extraction = await extraction.extractPending();
    } catch (error) {
      report.errors.push({ step: "extraction", error });
    }
    return report;
  }

  async function nextDueAt(): Promise<Date | null> {
    const times = (await Promise.all([polling.nextDueAt(), extraction.nextDueAt()])).flatMap((at) => (at ? [at.getTime()] : []));
    return times.length === 0 ? null : new Date(Math.min(...times));
  }

  return {
    /** One round of polling and extraction. A call while a round runs gets that round's report. */
    run(): Promise<DueWorkReport> {
      running ??= round().finally(() => {
        running = null;
      });
      return running;
    },

    /** When work is next due, now if some is already; null if there is none. */
    nextDueAt,

    /** How long to sleep before the next round: until work is due, but at most `maximumSleepMs`. */
    async sleepMs(): Promise<number> {
      const next = await nextDueAt();
      if (!next) return maximumSleepMs;
      return Math.min(maximumSleepMs, Math.max(0, next.getTime() - clock.now().getTime()));
    },

    /** Resolves once the round in flight, if any, is over. */
    async idle(): Promise<void> {
      await running;
    },
  };
}

export type DueWork = ReturnType<typeof createDueWork>;

/** Work that is not due at a moment but now and then, such as once a day. */
export function createCleanup(deps: { retention: Retention; secretSweep: SecretSweep }) {
  return {
    /** Deletes messages past their retention and sweeps the secrets nothing refers to. */
    async run(): Promise<{ purged: number; deleted: number; swept: number }> {
      const { purged, deleted } = await deps.retention.purge();
      const swept = await deps.secretSweep.sweep();
      return { purged, deleted, swept };
    },
  };
}

export type Cleanup = ReturnType<typeof createCleanup>;
