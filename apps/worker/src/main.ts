import { bootWorker } from "@family-agenda/api/composition-root";
import { readConfig } from "@family-agenda/api/config";

/** How often the worker looks for Sources whose polling interval has passed. */
const tickMs = 5_000;

const worker = await bootWorker(readConfig());
console.log("Family Agenda worker started");

worker.secretSweep.sweep().catch((error: unknown) => {
  console.error("Removing secrets nothing refers to failed:", error);
});

/** How often the worker deletes messages past their retention. */
const retentionTickMs = 60 * 60 * 1000;

const purge = () => {
  worker.retention.purge().catch((error: unknown) => {
    console.error("Purging messages past their retention failed:", error);
  });
};
purge();
const retentionTimer = setInterval(purge, retentionTickMs);

let polling: Promise<void> | null = null;
const poll = () => {
  // A tick that finds the last one still running skips, rather than polling a Source twice.
  polling ??= worker.polling
    .pollDue()
    .then((report) => {
      for (const failure of report.failed) {
        console.warn(`Source ${failure.sourceId} failed (${failure.kind}): ${failure.message}`);
      }
      for (const refusal of report.refused) {
        console.warn(`Source ${refusal.sourceId} named Source Attributes it never declared or had archived, so those records are refused: ${refusal.attributes.join(", ")}`);
      }
      for (const record of report.invalid) {
        console.warn(`Source ${record.sourceId} states an invalid Item for ${record.externalId}, which is not written: ${record.problems.join("; ")}`);
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
      for (const dropped of report.dropped) {
        console.warn(`An Item "${dropped.title ?? ""}" of message ${dropped.messageId} failed a check twice and is not written: ${dropped.problem}`);
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

const shutdown = () => {
  clearInterval(timer);
  clearInterval(retentionTimer);
  void Promise.resolve(polling)
    .then(() => worker.close())
    .then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
