import { bootSelfHostedWorker, createWorkerLoop, logDueWorkReport } from "@family-agenda/composition";

/** How often the worker starts and stops the programs of Source Types as Admins enable them. */
const servicesTickMs = 5_000;

/** How often the worker deletes messages past their retention and sweeps secrets nothing refers to. */
const cleanupTickMs = 24 * 60 * 60 * 1000;

const worker = await bootSelfHostedWorker();
const log = {
  warn: (message: string) => {
    console.warn(message);
  },
  error: (message: string, error?: unknown) => {
    console.error(message, error);
  },
};
const loop = createWorkerLoop(worker, log);
console.log("Family Agenda worker started");

const cleanup = () => {
  worker.cleanup.run().catch((error: unknown) => {
    console.error("Cleaning up (retention, secrets nothing refers to) failed:", error);
  });
};
cleanup();
const cleanupTimer = setInterval(cleanup, cleanupTickMs);

void loop.reconcile();
const servicesTimer = setInterval(() => void loop.reconcile(), servicesTickMs);

const stopping = new AbortController();
const isStopping = () => stopping.signal.aborted;
let wake = () => {};

/** Rounds of due work, each followed by a sleep until the next work is due. */
const working = (async () => {
  while (!isStopping()) {
    logDueWorkReport(await worker.dueWork.run(), log);
    if (isStopping()) break;
    const sleepMs = await worker.dueWork.sleepMs().catch(() => servicesTickMs);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, sleepMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
})();

const shutdown = () => {
  stopping.abort();
  wake();
  clearInterval(servicesTimer);
  clearInterval(cleanupTimer);
  void working
    .then(() => loop.stop())
    .then(() => worker.close())
    .then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
