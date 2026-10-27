import { bootWorker } from "@family-butler/api/composition-root";
import { readConfig } from "@family-butler/api/config";

/** How often the worker looks for Sources whose polling interval has passed. */
const tickMs = 30_000;

const worker = await bootWorker(readConfig());
console.log("Family Butler worker started");

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
    .finally(() => {
      polling = null;
    });
};
poll();
const timer = setInterval(poll, tickMs);

const shutdown = () => {
  clearInterval(timer);
  void Promise.resolve(polling)
    .then(() => worker.close())
    .then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
