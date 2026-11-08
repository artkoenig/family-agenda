import { createHash } from "node:crypto";
import type { SourceId, SourceTypeId } from "@family-agenda/domain";
import type { ActivityLog } from "./activity";
import { retainedSince } from "./retention";
import type {
  BlobStore,
  CatalogueRepository,
  CatalogueSpec,
  DeclaredAttribute,
  Clock,
  IngestedMessage,
  IngestedOrigin,
  ItemRepository,
  PollingIngestion,
  SecretStore,
  Source,
  SourceRepository,
  SourceTypeRegistry,
  SourceTypeRepository,
  StoredFile,
  StoredMessage,
} from "./ports";
import { readStated } from "./stated-items";
import { runContextOf } from "./sources";
import { defaultPluginTimeoutMs, noAnswerWithin, withinTime } from "./time-limit";

/** How many Sources of one Source Type run at once; Sources of different ones run side by side. */
export const pollsPerSourceType = 2;

/** The longest a Source waits after failed runs in a row, however many there were. */
export const maximumBackoffMs = 6 * 60 * 60 * 1000;

/** How much longer than a run may take a lease lasts, for writing what the run brought. */
const leaseMarginMs = 60 * 1000;

export type PollingDeps = {
  clock: Clock;
  /** The IANA time zone the Family lives in, which plugins read times without a zone in. */
  timeZone: string;
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  /** Where a catalogue entry's polling interval is, which its Sources are polled at. */
  catalogues: CatalogueRepository;
  sources: SourceRepository;
  secrets: SecretStore;
  items: ItemRepository;
  /** Where raw messages and their attachments are kept, outside Postgres. */
  blobs: BlobStore;
  /** Where the run shows as the worker's activity. */
  activity: ActivityLog;
  /** How long a plugin may take to run a Source before the run counts as failed; `defaultPluginTimeoutMs` if absent. */
  pluginTimeoutMs?: number;
};

export type PollReport = {
  /** The Sources run successfully. */
  polled: SourceId[];
  failed: { sourceId: SourceId; kind: "definite" | "temporary"; message: string }[];
  /** The entries whose stated Item was invalid, so that none was written, and why. */
  invalid: { sourceId: SourceId; externalId: string; problems: string[] }[];
  /** The Sources whose plugin emitted Origins naming Source Attributes it never declared, or had archived. */
  refused: { sourceId: SourceId; attributes: string[] }[];
};

/** The refusal to report for a run, none if it refused nothing. */
function refusalsOf(sourceId: SourceId, attributes: string[]): PollReport["refused"] {
  return attributes.length > 0 ? [{ sourceId, attributes }] : [];
}

export function createSourcePolling(deps: PollingDeps) {
  const { clock, timeZone, registry, sourceTypes, catalogues, sources, secrets, items, blobs, activity } = deps;
  const timeoutMs = deps.pluginTimeoutMs ?? defaultPluginTimeoutMs;

  async function store(contents: Uint8Array): Promise<StoredFile> {
    const sha256 = createHash("sha256").update(contents).digest("hex");
    return { blob: await blobs.put(contents), sha256, size: contents.byteLength };
  }

  /**
   * Puts a message's attachments into the BlobStore; its text, sender and subject go to Postgres.
   */
  async function stored(message: IngestedMessage, origin: IngestedOrigin): Promise<StoredMessage> {
    const attachments: StoredMessage["attachments"] = [];
    for (const { filename, contentType, bytes } of message.attachments) {
      attachments.push({ ...(await store(bytes)), filename, contentType });
    }
    return {
      sender: origin.sender,
      subject: origin.subject,
      body: message.text,
      attachments,
    };
  }

  async function removeBlobsOf(message: StoredMessage): Promise<void> {
    for (const file of message.attachments) await blobs.remove(file.blob);
  }

  /**
   * Runs one Source and records what it emitted into the report; whether its plugin did not answer
   * in time, so that its call may still be going on.
   */
  async function run(source: Source, ingestion: PollingIngestion, report: PollReport): Promise<{ timedOut: boolean }> {
    const now = clock.now();
    const aborting = new AbortController();
    const context = { ...(await runContextOf(source, { secrets, now, timeZone })), signal: aborting.signal };
    let timedOut = false;
    const result = await withinTime(ingestion.poll(context), timeoutMs, () => {
      timedOut = true;
      aborting.abort(new Error(noAnswerWithin(timeoutMs)));
      return { ok: false as const, kind: "temporary" as const, message: noAnswerWithin(timeoutMs) };
    });
    if (!result.ok) {
      await sources.recordFailedRun(source.id, now, { kind: result.kind, message: result.message });
      report.failed.push({ sourceId: source.id, kind: result.kind, message: result.message });
      return { timedOut };
    }
    await applyAttributes(source.id, result);
    const origins = await buildOrigins(result.origins);
    let known: string[];
    let withdrawnFiles;
    let invalid;
    let refused;
    try {
      ({ knownMessages: known, withdrawnFiles, invalid, refused } = await items.recordRun(
        { sourceId: source.id, at: now, retainedSince: retainedSince(now), syncCursor: result.syncCursor, withdrawn: result.withdrawn, origins },
        readStated,
      ));
    } catch (error) {
      await removeOriginBlobs(origins);
      throw error;
    }
    for (const origin of origins) if (origin.message && known.includes(origin.externalId)) await removeBlobsOf(origin.message);
    for (const file of withdrawnFiles) await blobs.remove(file);
    report.invalid.push(...invalid.map((record) => ({ sourceId: source.id, ...record })));
    report.refused.push(...refusalsOf(source.id, refused));
    report.polled.push(source.id);
    return { timedOut: false };
  }

  /** The Source Attributes a run reports; the Origins it emits may name them. */
  async function applyAttributes(sourceId: SourceId, result: { declared: DeclaredAttribute[]; archived: string[] }): Promise<void> {
    if (result.declared.length > 0) await sources.declareAttributes(sourceId, result.declared);
    for (const externalId of result.archived) await sources.archiveAttribute(sourceId, externalId);
  }

  async function buildOrigins(rawOrigins: IngestedOrigin[]) {
    const origins = [];
    for (const origin of rawOrigins) {
      origins.push({
        externalId: origin.externalId,
        occurredAt: origin.occurredAt,
        attributes: origin.attributes,
        sender: origin.sender,
        subject: origin.subject,
        link: origin.link,
        stated: origin.stated,
        message: origin.message ? await stored(origin.message, origin) : null,
      });
    }
    return origins;
  }

  async function removeOriginBlobs(origins: { message: StoredMessage | null }[]): Promise<void> {
    for (const origin of origins) if (origin.message) await removeBlobsOf(origin.message);
  }

/**
 * When a Source is next due: at once if it never ran, or last ran in the future (after a clock
 * change). After failed runs in a row it waits twice as long for each, up to `maximumBackoffMs` (or the interval, if longer).
 */
function dueAt(
  source: Source,
  ingestion: PollingIngestion,
  catalogue: CatalogueSpec | null,
  entryIntervals: Map<string, number | null>,
  now: number,
): number {
  const own = catalogue ? (entryIntervals.get(String(source.plain[catalogue.configKey])) ?? null) : source.pollIntervalSeconds;
  const interval = (own ?? ingestion.suggestedIntervalSeconds) * 1000;
  const backoff = Math.min(interval * 2 ** Math.max(0, source.consecutiveFailures - 1), Math.max(interval, maximumBackoffMs));
  const last = source.lastRunAt?.getTime();
  return last === undefined || last > now ? now : last + backoff;
}

  /** Every polling Source of the enabled Source Types with when it is due. */
  async function schedule(enabled: Set<SourceTypeId>, now: number): Promise<{ source: Source; ingestion: PollingIngestion; dueAt: number }[]> {
    const all: { source: Source; ingestion: PollingIngestion; dueAt: number }[] = [];
    for (const type of enabled) {
      const loaded = await registry.load(type);
      if (!loaded.ok) continue;
      const { ingestion, catalogue } = loaded.sourceType;
      if (ingestion.mode !== "polling") continue;
      const entryIntervals = new Map(
        catalogue ? (await catalogues.list(type)).map((record) => [record.entryId, record.pollIntervalSeconds]) : [],
      );
      for (const source of await sources.listOfType(type)) {
        all.push({ source, ingestion, dueAt: dueAt(source, ingestion, catalogue, entryIntervals, now) });
      }
    }
    return all;
  }

  /**
   * Runs `work` while this worker holds the Source; skips it while another worker does, or if one
   * ran it since it was listed. A run whose plugin did not answer keeps the lease until it ends, as
   * its call may still be going on.
   */
  async function leased(source: Source, work: () => Promise<{ timedOut: boolean }>): Promise<void> {
    const now = clock.now();
    const until = new Date(now.getTime() + timeoutMs + leaseMarginMs);
    if (!(await sources.lease(source.id, { now, until, lastRunAt: source.lastRunAt }))) return;
    let timedOut = false;
    try {
      ({ timedOut } = await work());
    } finally {
      // A lease that cannot be let go of ends by itself; the run's own error matters more.
      if (!timedOut) await sources.release(source.id, until).catch(() => undefined);
    }
  }

  async function enabledTypes(): Promise<Set<SourceTypeId>> {
    return new Set((await sourceTypes.list()).filter((type) => type.enabled).map((type) => type.id));
  }

  return {
    /** When the first polling Source is due, now if one is already; null if there is none. */
    async nextDueAt(): Promise<Date | null> {
      const times = (await schedule(await enabledTypes(), clock.now().getTime())).map((entry) => entry.dueAt);
      return times.length === 0 ? null : new Date(Math.min(...times));
    },

    /**
     * Runs every polling Source of an enabled Source Type whose interval has passed since its last
     * run, as the worker does on each tick, each under a lease and within the plugin timeout; Source
     * Types side by side, a few Sources of each at once. A failed run waits twice as long each time. A Source
     * using a catalogue entry, such as a Messenger, is polled at the entry's interval.
     */
    async pollDue(): Promise<PollReport> {
      const report: PollReport = { polled: [], failed: [], invalid: [], refused: [] };
      const now = clock.now().getTime();
      const due = (await schedule(await enabledTypes(), now)).filter((entry) => entry.dueAt <= now);
      if (due.length === 0) return report;
      const progress = await activity.begin("polling", due.length);
      const byType = new Map<SourceTypeId, typeof due>();
      for (const entry of due) byType.set(entry.source.sourceTypeId, [...(byType.get(entry.source.sourceTypeId) ?? []), entry]);
      let outcomes: PromiseSettledResult<void>[];
      try {
        outcomes = await Promise.allSettled(
          [...byType.values()].map((entries) =>
            inTurns(entries, pollsPerSourceType, async ({ source, ingestion }) => {
              await leased(source, () => run(source, ingestion, report));
              await progress.advance();
            }),
          ),
        );
      } finally {
        await progress.end();
      }
      const thrown = outcomes.find((outcome) => outcome.status === "rejected");
      if (thrown) throw thrown.reason;
      return report;
    },
  };
}

export type SourcePolling = ReturnType<typeof createSourcePolling>;

/**
 * Does `work` for every entry, at most `parallel` at once; all of them even when some throw,
 * rejecting then with the first error.
 */
async function inTurns<T>(entries: T[], parallel: number, work: (entry: T) => Promise<void>): Promise<void> {
  const queue = [...entries];
  const errors: unknown[] = [];
  const lane = async () => {
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      await work(entry).catch((error: unknown) => errors.push(error));
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, entries.length) }, lane));
  if (errors.length > 0) throw errors[0];
}
