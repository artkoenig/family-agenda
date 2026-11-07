import type { DueWorkReport } from "@family-agenda/application";
import type { Worker } from "./boot";

/** Where the loop reports what went wrong; the process decides where that goes. */
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

/** The state of the services of Source Types of one Instance. Nothing of it lives at module scope. */
export type WorkerLoop = {
  /** Starts and stops the programs of Source Types as Admins enable them; skips if the last run is still going. */
  reconcile(): Promise<void>;
  /** Waits for the runs in flight, then stops the services of Source Types. Does not close the Worker. */
  stop(): Promise<void>;
};

/** The supervision of Source Types' services of one Worker, with its own "running" flag and failure memory. */
export function createWorkerLoop(worker: Worker, log: WorkerLog): WorkerLoop {
  let reconciling: Promise<void> | null = null;
  /** Messages of the last failures, so that a failure that stays is logged once. */
  let lastFailures = "";

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
    await Promise.all([worker.dueWork.idle(), reconciling]);
    await worker.services.stop();
  };

  return { reconcile, stop };
}
