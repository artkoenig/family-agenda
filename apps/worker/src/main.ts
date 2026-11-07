import { bootSelfHostedWorker, createWorkerLoop } from "@family-agenda/composition";

/** How often the worker looks for Sources whose polling interval has passed. */
const tickMs = 5_000;

/** How often the worker starts and stops the programs of Source Types as Admins enable them. */
const servicesTickMs = 5_000;

/** How often the worker deletes messages past their retention. */
const retentionTickMs = 60 * 60 * 1000;

const worker = await bootSelfHostedWorker();
const loop = createWorkerLoop(worker, {
  warn: (message) => {
    console.warn(message);
  },
  error: (message, error) => {
    console.error(message, error);
  },
});
console.log("Family Agenda worker started");

worker.secretSweep.sweep().catch((error: unknown) => {
  console.error("Removing secrets nothing refers to failed:", error);
});

const purge = () => {
  worker.retention.purge().catch((error: unknown) => {
    console.error("Purging messages past their retention failed:", error);
  });
};
purge();
const retentionTimer = setInterval(purge, retentionTickMs);

void loop.poll();
const timer = setInterval(() => void loop.poll(), tickMs);

void loop.reconcile();
const servicesTimer = setInterval(() => void loop.reconcile(), servicesTickMs);

const shutdown = () => {
  clearInterval(timer);
  clearInterval(servicesTimer);
  clearInterval(retentionTimer);
  void loop
    .stop()
    .then(() => worker.close())
    .then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
