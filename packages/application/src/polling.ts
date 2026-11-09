import { createHash } from "node:crypto";
import type { SourceId, SourceTypeId } from "@family-agenda/domain";
import type { ActivityLog } from "./activity";
import { retainedSince } from "./retention";
import type {
  BlobStore,
  CatalogueRepository,
  CatalogueSpec,
  Clock,
  IngestedMessage,
  IngestedOrigin,
  ItemRepository,
  AttributeReporting,
  PollingIngestion,
  SecretStore,
  SourceRunContext,
  Source,
  SourceRepository,
  SecretRef,
  SourceRunResult,
  SourceTypeRegistry,
  SourceTypeRepository,
  StoredFile,
  StoredMessage,
} from "./ports";
import { enabledSourceType } from "./enabled-source-type";
import { readStated } from "./stated-items";
import { runContextOf } from "./sources";

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
  /** Where raw messages and their attachments are kept, outside Postgres (ADR-0006). */
  blobs: BlobStore;
  /** Where the run shows as the worker's activity. */
  activity: ActivityLog;
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

  /** Runs one Source, by polling it or handing it a pushed payload, and records what it emitted into the report. */
  async function run(source: Source, ingest: Ingest, report: PollReport): Promise<void> {
    const now = clock.now();
    const result = await ingest(await runContextOf(source, { secrets, now, timeZone }), {
      declare: (attributes) => sources.declareAttributes(source.id, attributes),
      archive: (externalId) => sources.archiveAttribute(source.id, externalId),
    });
    if (!result.ok) {
      await sources.recordFailedRun(source.id, now, { kind: result.kind, message: result.message });
      report.failed.push({ sourceId: source.id, kind: result.kind, message: result.message });
      return;
    }
    // Changed secrets are stored before the cursor advances: a refreshed token must not be lost.
    const replacedSecrets = await storeChangedSecrets(source, result.secrets ?? {});
    const origins = await buildOrigins(result.origins);
    const { knownMessages: known, withdrawnFiles, invalid, refused } = await recordRun(source, now, result, origins);
    await removeLeftovers(origins.flatMap((origin) => (origin.message && known.includes(origin.externalId) ? [origin.message] : [])), withdrawnFiles, replacedSecrets);
    report.invalid.push(...invalid.map((record) => ({ sourceId: source.id, ...record })));
    report.refused.push(...refusalsOf(source.id, refused));
    report.polled.push(source.id);
  }

  /** Removes what a recorded run left over: files of messages already known, withdrawn files and replaced secrets. */
  async function removeLeftovers(knownMessages: Parameters<typeof removeBlobsOf>[0][], withdrawnFiles: Parameters<typeof blobs.remove>[0][], replacedSecrets: SecretRef[]) {
    for (const message of knownMessages) await removeBlobsOf(message);
    for (const file of withdrawnFiles) await blobs.remove(file);
    for (const ref of replacedSecrets) await secrets.remove(ref);
  }

  /** Records a successful run with its Origins; their files go again if that fails. */
  async function recordRun(source: Source, now: Date, result: Extract<SourceRunResult, { ok: true }>, origins: Awaited<ReturnType<typeof buildOrigins>>) {
    try {
      return await items.recordRun(
        { sourceId: source.id, at: now, retainedSince: retainedSince(now), syncCursor: result.syncCursor, withdrawn: result.withdrawn, origins },
        readStated,
      );
    } catch (error) {
      await removeOriginBlobs(origins);
      throw error;
    }
  }

  /** Stores the secrets a plugin changed, such as a refreshed token; returns the ones they replace, to remove once the run is recorded. */
  async function storeChangedSecrets(source: Source, changed: Record<string, string>): Promise<SecretRef[]> {
    const entries = Object.entries(changed);
    if (entries.length === 0) return [];
    const refs = { ...source.secrets };
    for (const [key, value] of entries) refs[key] = await secrets.put(value);
    await sources.replaceSecrets(source.id, refs);
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

    async function findDue(enabled: Set<SourceTypeId>, now: number): Promise<{ source: Source; ingestion: PollingIngestion }[]> {
    const due: { source: Source; ingestion: PollingIngestion }[] = [];
    for (const type of enabled) {
      const loaded = await registry.load(type);
      if (!loaded.ok) continue;
      const { ingestion, catalogue } = loaded.sourceType;
      if (ingestion.mode !== "polling") continue;
      const entryIntervals = new Map(
        catalogue ? (await catalogues.list(type)).map((record) => [record.entryId, record.pollIntervalSeconds]) : [],
      );
      for (const source of await sources.listOfType(type)) {
        if (isDue(source, ingestion, catalogue, entryIntervals, now)) {
          due.push({ source, ingestion });
        }
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
    async pollDue(): Promise<PollReport> {
      const report: PollReport = { polled: [], failed: [], invalid: [], refused: [] };
      const enabled = new Set((await sourceTypes.list()).filter((type) => type.enabled).map((type) => type.id));
      const now = clock.now().getTime();
      const due = await findDue(enabled, now);
      if (due.length === 0) return report;
      const progress = await activity.begin("polling", due.length);
      try {
        for (const { source, ingestion } of due) {
          await run(source, (context, attributes) => ingestion.poll(context, attributes), report);
          await progress.advance();
        }
      } finally {
        await progress.end();
      }
      return report;
    },

    /**
     * Hands a payload pushed to the core for a Source to its plugin, and records what it emitted as
     * a poll would. Only a Source whose Source Type is enabled, loadable and ingests by push receives one.
     */
    async receive(sourceId: SourceId, payload: Uint8Array): Promise<ReceiveResult> {
      const source = await sources.findById(sourceId);
      if (!source) return { ok: false, problem: "unknown-source" };
      const ingestion = (await enabledSourceType(source.sourceTypeId, { registry, sourceTypes }))?.ingestion;
      if (ingestion?.mode !== "push") return { ok: false, problem: "not-push" };
      const report: PollReport = { polled: [], failed: [], invalid: [], refused: [] };
      await run(source, (context, attributes) => ingestion.receive(context, payload, attributes), report);
      return { ok: true, report };
    },
  };
}

type Ingest = (context: SourceRunContext, attributes: AttributeReporting) => Promise<SourceRunResult>;

/** What receiving a pushed payload came to: the run as a poll reports it, or why there was none. */
export type ReceiveResult = { ok: true; report: PollReport } | { ok: false; problem: "unknown-source" | "not-push" };

export type SourcePolling = ReturnType<typeof createSourcePolling>;
