import type { ExtractionReport, PollReport } from "@family-agenda/application";
import type { Worker } from "./boot";

/** What the worker needs to know of a Family to work on its Instance; sent with every trigger. */
export type FamilyDatabase = {
  databaseUrl: string;
  /** The 32-byte key the Family's Source credentials are encrypted with. */
  masterKey: Buffer;
  /** Where the Family's files are kept, outside Postgres. */
  blobDirectory: string;
  /** The Family's IANA time zone. */
  timeZone: string;
};

export type CleanupReport = { purged: number; deleted: number; swept: number };

/** The work the worker does for a Family when triggered; it neither loops nor sleeps. */
export type WorkerService = {
  /** Polls the Family's due Sources; when work is next due afterwards. */
  poll(family: FamilyDatabase): Promise<{ report: PollReport; nextDueAt: Date | null }>;
  /** Extracts the Family's pending messages; when work is next due afterwards. */
  extract(family: FamilyDatabase): Promise<{ report: ExtractionReport; nextDueAt: Date | null }>;
  /** Deletes messages past their retention and sweeps the secrets nothing refers to. */
  cleanup(family: FamilyDatabase): Promise<CleanupReport>;
  /** Waits for the work in flight and closes every Family's database. */
  close(): Promise<void>;
};

type Operation = "poll" | "extract" | "cleanup";

/**
 * The worker's work for any number of Families, each in a database of its own. It boots a Family's
 * Instance on its first trigger and keeps it, with its connection. It runs no services of Source
 * Types, such as the Matrix homeserver and bridges. A trigger while the same work of the same
 * Family runs gets that run's result.
 */
export function createWorkerService(boot: (family: FamilyDatabase) => Promise<Worker>): WorkerService {
  const instances = new Map<string, Promise<Worker>>();
  const inFlight = new Map<string, Promise<unknown>>();

  const instanceOf = (family: FamilyDatabase): Promise<Worker> => {
    let instance = instances.get(family.databaseUrl);
    if (!instance) {
      instance = boot(family);
      instances.set(family.databaseUrl, instance);
      // A Family that failed to boot is booted again on its next trigger.
      instance.catch(() => instances.delete(family.databaseUrl));
    }
    return instance;
  };

  const once = <T>(operation: Operation, family: FamilyDatabase, work: (worker: Worker) => Promise<T>): Promise<T> => {
    const key = `${operation} ${family.databaseUrl}`;
    let running = inFlight.get(key) as Promise<T> | undefined;
    if (!running) {
      running = instanceOf(family)
        .then(work)
        .finally(() => inFlight.delete(key));
      inFlight.set(key, running);
    }
    return running;
  };

  return {
    poll: (family) =>
      once("poll", family, async (worker) => ({ report: await worker.polling.pollDue(), nextDueAt: await worker.dueWork.nextDueAt() })),
    extract: (family) =>
      once("extract", family, async (worker) => ({ report: await worker.extraction.extractPending(), nextDueAt: await worker.dueWork.nextDueAt() })),
    cleanup: (family) => once("cleanup", family, (worker) => worker.cleanup.run()),
    async close() {
      await Promise.allSettled(inFlight.values());
      const booted = await Promise.allSettled(instances.values());
      instances.clear();
      await Promise.all(booted.flatMap((result) => (result.status === "fulfilled" ? [result.value.close()] : [])));
    },
  };
}
