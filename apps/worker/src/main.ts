import { bootWorker } from "@family-agenda/api/composition-root";
import { readConfig } from "@family-agenda/api/config";

/** How often the worker looks for Sources whose polling interval has passed. */
const tickMs = 30_000;

/** How often the worker starts and stops the programs of Source Types as Admins enable them. */
const servicesTickMs = 5_000;

const worker = await bootWorker(readConfig());
console.log("Family Agenda worker started");

worker.secretSweep.sweep().catch((error: unknown) => {
  console.error("Removing secrets nothing refers to failed:", error);
});

let polling: Promise<void> | null = null;
const poll = () => {
  // A tick that finds the last one still running skips, rather than polling a Source twice.
  polling ??= worker.polling
    .pollDue()
    .then((report) => {
      for (const failure of report.failed) {
        console.warn(`Source ${failure.sourceId} failed (${failure.kind}): ${failure.message}`);
      }
    })
    .catch((error: unknown) => {
      console.error("Polling Sources failed:", error);
    })
    // Then the messages the Sources brought in, each once.
    .then(() => worker.extraction.extractPending())
    .then((report) => {
      for (const failure of report.failed) {
        console.warn(`Extracting message ${failure.messageId} failed (${failure.problem}): ${failure.message}`);
      }
    })
    .catch((error: unknown) => {
      console.error("Extracting messages failed:", error);
    })
    .finally(() => {
      polling = null;
    });
};
poll();
const timer = setInterval(poll, tickMs);

let reconciling: Promise<void> | null = null;
/** Messages of the last failures, so that a failure that stays is logged once. */
let lastFailures = "";
const reconcile = () => {
  reconciling ??= worker.services
    .reconcile()
    .then((report) => {
      const failures = report.failed.map((failure) => `Services of Source Type ${failure.sourceTypeId} failed: ${failure.message}`).join("\n");
      if (failures !== "" && failures !== lastFailures) console.warn(failures);
      lastFailures = failures;
    })
    .catch((error: unknown) => {
      console.error("Reconciling the services of Source Types failed:", error);
    })
    .finally(() => {
      reconciling = null;
    });
};
reconcile();
const servicesTimer = setInterval(reconcile, servicesTickMs);

const shutdown = () => {
  clearInterval(timer);
  clearInterval(servicesTimer);
  void Promise.all([polling, reconciling])
    .then(() => worker.services.stop())
    .then(() => worker.close())
    .then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
