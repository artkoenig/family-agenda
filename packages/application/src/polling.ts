import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { SourceId, SourceTypeId } from "@family-agenda/domain";
import type { ActivityLog } from "./activity";
import { retainedSince } from "./retention";
import type {
  BlobStore,
  CatalogueRepository,
  CatalogueSpec,
  Clock,
  DeclaredAttribute,
  IngestedMessage,
  IngestedOrigin,
  ItemRepository,
  AttributeReporting,
  PollingIngestion,
  SecretStore,
  SourceRunContext,
  Source,
  SourceRepository,
  SourceRunTurns,
  SecretRef,
  SourceRunResult,
  SourceTypeRegistry,
  SourceTypeRepository,
  StoredFile,
  StoredMessage,
} from "./ports";
import { TurnLost } from "./ports";
import { enabledSourceType } from "./enabled-source-type";
import { readStated } from "./stated-items";
import { runContextOf, type HostFieldsOf } from "./sources";

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
  /** Where raw messages and their attachments are kept, outside Postgres (ADR-0003). */
  blobs: BlobStore;
  /** Where the run shows as the worker's activity. */
  activity: ActivityLog;
  /** Who of the Family's processes runs a Source now, so that its runs take turns across them. */
  turns: SourceRunTurns;
  /** Replaces how long turns last and are waited for, such as in a test that outlasts one. */
  turnTimings?: Partial<TurnTimings>;
};

/** How the runs of a Source take turns across processes. */
export type TurnTimings = {
  /** How long a turn lasts unless renewed: how long after a process died its runs are known to be over. */
  lastsMs: number;
  /** How often a run renews its turn while it lasts. */
  renewedEveryMs: number;
  /** How often a pushed payload waiting for another process's run of the Source asks for the turn again. */
  askedEveryMs: number;
  /** How long a pushed payload waits for the turn before its run fails temporarily. */
  waitsAtMostMs: number;
};

const defaultTurnTimings: TurnTimings = { lastsMs: 60_000, renewedEveryMs: 20_000, askedEveryMs: 50, waitsAtMostMs: 120_000 };

/** What a round of runs came to, by polling or by a pushed payload. */
export type RunReport = {
  /** The Sources run successfully. */
  ran: SourceId[];
  failed: { sourceId: SourceId; kind: "definite" | "temporary"; message: string }[];
  /** The entries whose stated Item was invalid, so that none was written, and why. */
  invalid: { sourceId: SourceId; externalId: string; problems: string[] }[];
  /** The Sources whose plugin emitted Origins naming Source Attributes it never declared, or had archived. */
  refused: { sourceId: SourceId; attributes: string[] }[];
  /** The Sources whose run lost its turn to another process before it was recorded, so that nothing of it was. */
  lost: SourceId[];
};

const emptyReport = (): RunReport => ({ ran: [], failed: [], invalid: [], refused: [], lost: [] });

/** The refusal to report for a run, none if it refused nothing. */
function refusalsOf(sourceId: SourceId, attributes: string[]): RunReport["refused"] {
  return attributes.length > 0 ? [{ sourceId, attributes }] : [];
}

export function createSourcePolling(deps: PollingDeps) {
  const { clock, timeZone, registry, sourceTypes, catalogues, sources, secrets, items, blobs, activity, turns } = deps;
  const timings: TurnTimings = { ...defaultTurnTimings, ...deps.turnTimings };
  /** This process, as the holder of the turns its runs take. */
  const holder = randomUUID();

  /**
   * Takes the Source's turn, kept in the Family's database: once for a poll, which leaves a Source
   * another process runs to the next round; for a pushed payload, again and again while another
   * process runs it, up to `waitsAtMostMs`. Whether it got it.
   */
  async function takeTurn(sourceId: SourceId, waits: boolean): Promise<boolean> {
    const since = performance.now();
    for (;;) {
      if (await turns.take(sourceId, holder, timings.lastsMs)) return true;
      if (!waits || performance.now() - since >= timings.waitsAtMostMs) return false;
      await sleep(timings.askedEveryMs);
    }
  }

  /**
   * Does the work in the Source's turn, renewing it while the work lasts and ending it after. The
   * work is told whether the turn was lost meanwhile, so that it records nothing then.
   */
  async function inTurn(sourceId: SourceId, work: (lost: () => boolean) => Promise<void>): Promise<void> {
    let lost = false;
    const renewal = setInterval(() => {
      turns
        .renew(sourceId, holder, timings.lastsMs)
        .then((held) => {
          if (!held) lost = true;
        })
        .catch((error: unknown) => {
          console.error(`Renewing the turn of the run of Source ${sourceId} failed:`, error);
        });
    }, timings.renewedEveryMs);
    try {
      await work(() => lost);
    } finally {
      clearInterval(renewal);
      await turns.end(sourceId, holder);
    }
  }

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
   * The run of each Source under way or queued in this process, which the next run of it waits for
   * before it asks the database for the turn, so that a process's own runs queue without asking.
   */
  const runs = new Map<SourceId, Promise<void>>();

  /**
   * Runs one Source, by polling it or handing it a pushed payload, and records what it emitted into
   * the report. Runs of one Source take turns, a poll as well as a push, each reading the Source
   * afresh, so that none starts from a Sync Cursor another is about to replace. They take turns
   * across the Family's processes too (ADR-0008). A poll, given `isDueNow`, skips a Source another
   * process runs, and runs only if the Source, read afresh, is still due: another process may have
   * polled it meanwhile.
   */
  async function run(sourceId: SourceId, sourceType: HostFieldsOf, ingest: Ingest, report: RunReport, isDueNow?: (source: Source) => boolean): Promise<void> {
    const previous = runs.get(sourceId) ?? Promise.resolve();
    const current = previous.then(async () => {
      if (!(await takeTurn(sourceId, !isDueNow))) {
        if (!isDueNow) report.failed.push({ sourceId, kind: "temporary", message: `another run of the Source did not end within ${timings.waitsAtMostMs / 1000} s` });
        return;
      }
      await inTurn(sourceId, async (lost) => {
        const source = await sources.findById(sourceId);
        if (source && (isDueNow?.(source) ?? true)) await runNow(source, sourceType, ingest, report, lost);
      });
    });
    const settled = current.catch(() => undefined);
    runs.set(sourceId, settled);
    try {
      await current;
    } finally {
      if (runs.get(sourceId) === settled) runs.delete(sourceId);
    }
  }

  async function runNow(source: Source, sourceType: HostFieldsOf, ingest: Ingest, report: RunReport, lost: () => boolean): Promise<void> {
    const now = clock.now();
    const attributes = attributesInTurn(source.id, lost);
    const result = await ingest(await runContextOf(source, sourceType, { secrets, now, timeZone }), attributes);
    if (attributes.lost()) {
      report.lost.push(source.id);
      return;
    }
    // Every write of a run checks its turn in the database: `lost` is only as fresh as the last renewal.
    if (!result.ok) {
      if (await sources.recordFailedRunInTurn(source.id, holder, now, { kind: result.kind, message: result.message })) {
        report.failed.push({ sourceId: source.id, kind: result.kind, message: result.message });
      } else report.lost.push(source.id);
      return;
    }
    // Changed secrets are stored before the cursor advances: a refreshed token must not be lost.
    const replacedSecrets = await storeChangedSecrets(source, result.secrets ?? {});
    if (replacedSecrets === null) {
      report.lost.push(source.id);
      return;
    }
    const origins = await buildOrigins(result.origins);
    const recorded = await recordRun(source, now, result, origins);
    if (!recorded) {
      report.lost.push(source.id);
      return;
    }
    const { knownMessages: known, withdrawnFiles, invalid, refused } = recorded;
    await removeLeftovers(origins.flatMap((origin) => (origin.message && known.includes(origin.externalId) ? [origin.message] : [])), withdrawnFiles, replacedSecrets);
    report.invalid.push(...invalid.map((record) => ({ sourceId: source.id, ...record })));
    report.refused.push(...refusalsOf(source.id, refused));
    report.ran.push(source.id);
  }

  /**
   * The writes of the Source's attributes its plugin makes during the call, each only while the run
   * holds the turn; once one finds it lost, so is the run, and it writes no more. `lost` tells
   * whether the run lost its turn, by a renewal or by one of these writes.
   */
  function attributesInTurn(sourceId: SourceId, renewalLost: () => boolean) {
    let lost = false;
    const inTurn = async (write: () => Promise<boolean>) => {
      if (!lost && !(await write())) lost = true;
    };
    return {
      declare: (declared: DeclaredAttribute[]) => inTurn(() => sources.declareAttributesInTurn(sourceId, holder, declared)),
      archive: (externalId: string) => inTurn(() => sources.archiveAttributeInTurn(sourceId, holder, externalId)),
      lost: () => lost || renewalLost(),
    };
  }

  /** Removes what a recorded run left over: files of messages already known, withdrawn files and replaced secrets. */
  async function removeLeftovers(knownMessages: Parameters<typeof removeBlobsOf>[0][], withdrawnFiles: Parameters<typeof blobs.remove>[0][], replacedSecrets: SecretRef[]) {
    for (const message of knownMessages) await removeBlobsOf(message);
    for (const file of withdrawnFiles) await blobs.remove(file);
    for (const ref of replacedSecrets) await secrets.remove(ref);
  }

  /** Records a successful run with its Origins, null if its turn was lost; their files go again if it is not recorded. */
  async function recordRun(source: Source, now: Date, result: Extract<SourceRunResult, { ok: true }>, origins: Awaited<ReturnType<typeof buildOrigins>>) {
    try {
      return await items.recordRun(
        // Retention by the clock now, not the run's start: a purge during the plugin's call may have
        // deleted the row of a message that has passed it since (specs/source-records).
        { sourceId: source.id, holder, at: now, retainedSince: retainedSince(clock.now()), syncCursor: result.syncCursor, withdrawn: result.withdrawn, origins },
        readStated,
      );
    } catch (error) {
      await removeOriginBlobs(origins);
      if (error instanceof TurnLost) return null;
      throw error;
    }
  }

  /**
   * Stores the secrets the plugin changed, such as a refreshed token, and points the Source at
   * them; returns the references they replace, to remove once the run is recorded, or null if the
   * run's turn was lost, which stores none of them.
   */
  async function storeChangedSecrets(source: Source, changed: Record<string, string>): Promise<SecretRef[] | null> {
    const entries = Object.entries(changed);
    if (entries.length === 0) return [];
    const refs = { ...source.secrets };
    const stored: SecretRef[] = [];
    for (const [key, value] of entries) {
      const ref = await secrets.put(value);
      refs[key] = ref;
      stored.push(ref);
    }
    if (!(await sources.replaceSecretsInTurn(source.id, holder, refs))) {
      for (const ref of stored) await secrets.remove(ref);
      return null;
    }
    return entries.flatMap(([key]) => source.secrets[key] ?? []);
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

function isDue(
  source: Source,
  ingestion: PollingIngestion,
  catalogue: CatalogueSpec | null,
  entryIntervals: Map<string, number | null>,
  now: number,
): boolean {
  const own = catalogue ? (entryIntervals.get(String(source.plain[catalogue.configKey])) ?? null) : source.pollIntervalSeconds;
  const interval = (own ?? ingestion.suggestedIntervalSeconds) * 1000;
  return !(source.lastRunAt && now - source.lastRunAt.getTime() < interval);
}

  type DueSource = { source: Source; ingestion: PollingIngestion; sourceType: HostFieldsOf; isDueNow: (source: Source) => boolean };

  async function findDue(enabled: Set<SourceTypeId>, now: number): Promise<DueSource[]> {
    const due: DueSource[] = [];
    for (const type of enabled) {
      const loaded = await registry.load(type);
      if (!loaded.ok) continue;
      const { ingestion, catalogue } = loaded.sourceType;
      if (ingestion.mode !== "polling") continue;
      const entryIntervals = new Map(
        catalogue ? (await catalogues.list(type)).map((record) => [record.entryId, record.pollIntervalSeconds]) : [],
      );
      const isDueNow = (source: Source) => isDue(source, ingestion, catalogue, entryIntervals, now);
      for (const source of await sources.listOfType(type)) {
        if (isDueNow(source)) due.push({ source, ingestion, sourceType: loaded.sourceType, isDueNow });
      }
    }
    return due;
  }

  return {
    /**
     * Runs every polling Source of an enabled Source Type whose interval has passed since its last
     * run, as the worker does on each tick. A failed run waits for the next interval too. A Source
     * using a catalogue entry, such as a Messenger, is polled at the entry's interval.
     */
    async pollDue(): Promise<RunReport> {
      const report = emptyReport();
      const enabled = new Set((await sourceTypes.list()).filter((type) => type.enabled).map((type) => type.id));
      const now = clock.now().getTime();
      const due = await findDue(enabled, now);
      if (due.length === 0) return report;
      const progress = await activity.begin("polling", due.length);
      try {
        for (const { source, ingestion, sourceType, isDueNow } of due) {
          await run(source.id, sourceType, (context, attributes) => ingestion.poll(context, attributes), report, isDueNow);
          await progress.advance();
        }
      } finally {
        await progress.end();
      }
      return report;
    },

    /**
     * Hands a payload pushed to the core for a Source to its plugin, and records what it emitted as
     * a poll would, taking turns with its other runs. Only a Source whose Source Type is enabled,
     * loadable and ingests by push receives one.
     */
    async receive(sourceId: SourceId, payload: Uint8Array): Promise<ReceiveResult> {
      const source = await sources.findById(sourceId);
      if (!source) return { ok: false, problem: "unknown-source" };
      const sourceType = await enabledSourceType(source.sourceTypeId, { registry, sourceTypes });
      if (!sourceType) return { ok: false, problem: "source-type-not-available" };
      const { ingestion } = sourceType;
      if (ingestion.mode !== "push") return { ok: false, problem: "not-push" };
      const report = emptyReport();
      await run(source.id, sourceType, (context, attributes) => ingestion.receive(context, payload, attributes), report);
      return { ok: true, report };
    },
  };
}

type Ingest = (context: SourceRunContext, attributes: AttributeReporting) => Promise<SourceRunResult>;

/**
 * What receiving a pushed payload came to: the run as a poll reports it, or why there was none:
 * no such Source, its Source Type is not enabled or its plugin not loadable, or it polls instead.
 */
export type ReceiveResult = { ok: true; report: RunReport } | { ok: false; problem: "unknown-source" | "source-type-not-available" | "not-push" };

export type SourcePolling = ReturnType<typeof createSourcePolling>;
