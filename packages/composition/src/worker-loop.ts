import type { Worker } from "./boot";

/** Where the loop reports what went wrong; the process decides where that goes. */
export type WorkerLog = { warn(message: string): void; error(message: string, error?: unknown): void };

/** The state of the background work of one Instance. Nothing of it lives at module scope. */
export type WorkerLoop = {
  /** Looks for due Sources, polls them and extracts their messages; skips if the last run is still going. */
  poll(): Promise<void>;
  /** Starts and stops the programs of Source Types as Admins enable them; skips if the last run is still going. */
  reconcile(): Promise<void>;
  /** Waits for the runs in flight, then stops the services of Source Types. Does not close the Worker. */
  stop(): Promise<void>;
};

/** The background work of one Worker, with its own "running" flags and failure memory. */
export function createWorkerLoop(worker: Worker, log: WorkerLog): WorkerLoop {
  let polling: Promise<void> | null = null;
  let reconciling: Promise<void> | null = null;
  /** Messages of the last failures, so that a failure that stays is logged once. */
  let lastFailures = "";

  const poll = () => {
    // A tick that finds the last one still running skips, rather than polling a Source twice.
    polling ??= worker.polling
      .pollDue()
      .then((report) => {
        for (const failure of report.failed) {
          log.warn(`Source ${failure.sourceId} failed (${failure.kind}): ${failure.message}`);
        }
        for (const refusal of report.refused) {
          log.warn(`Source ${refusal.sourceId} named Source Attributes it never declared or had archived, so those records are refused: ${refusal.attributes.join(", ")}`);
        }
        for (const record of report.invalid) {
          log.warn(`Source ${record.sourceId} states an invalid Item for ${record.externalId}, which is not written: ${record.problems.join("; ")}`);
        }
      })
      .catch((error: unknown) => {
        log.error("Polling Sources failed:", error);
      })
      // Then the messages the Sources brought in, each once.
      .then(() => worker.extraction.extractPending())
      .then((report) => {
        for (const failure of report.failed) {
          log.warn(`Extracting message ${failure.messageId} failed (${failure.problem}): ${failure.message}`);
        }
        for (const dropped of report.dropped) {
          log.warn(`An Item "${dropped.title ?? ""}" of message ${dropped.messageId} failed a check twice and is not written: ${dropped.problem}`);
        }
      })
      .catch((error: unknown) => {
        log.error("Extracting messages failed:", error);
      })
      .finally(() => {
        polling = null;
      });
    return polling;
  };

  const reconcile = () => {
    reconciling ??= worker.services
      .reconcile()
      .then((report) => {
        const failures = report.failed.map((failure) => `Services of Source Type ${failure.sourceTypeId} failed: ${failure.message}`).join("\n");
        if (failures !== "" && failures !== lastFailures) log.warn(failures);
        lastFailures = failures;
      })
      .catch((error: unknown) => {
        log.error("Reconciling the services of Source Types failed:", error);
      })
      .finally(() => {
        reconciling = null;
      });
    return reconciling;
  };

  const stop = async () => {
    await Promise.all([polling, reconciling]);
    await worker.services.stop();
  };

  return { poll, reconcile, stop };
}
