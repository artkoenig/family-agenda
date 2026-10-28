import { createHash } from "node:crypto";
import type { SourceId } from "@family-agenda/domain";
import type { ActivityLog } from "./activity";
import type {
  BlobStore,
  Clock,
  IngestedMessage,
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
import { checked, project } from "./revisions";
import { runContextOf } from "./sources";

export type PollingDeps = {
  clock: Clock;
  /** The IANA time zone the Family lives in, which plugins read times without a zone in. */
  timeZone: string;
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
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
};

export function createSourcePolling(deps: PollingDeps) {
  const { clock, timeZone, registry, sourceTypes, sources, secrets, items, blobs, activity } = deps;

  async function store(contents: Uint8Array): Promise<StoredFile> {
    const sha256 = createHash("sha256").update(contents).digest("hex");
    return { blob: await blobs.put(contents), sha256, size: contents.byteLength };
  }

  /** Puts a message's text and attachments into the BlobStore. */
  async function stored(message: IngestedMessage): Promise<StoredMessage> {
    const attachments: StoredMessage["attachments"] = [];
    for (const { filename, contentType, bytes } of message.attachments) {
      attachments.push({ ...(await store(bytes)), filename, contentType });
    }
    return { text: await store(new TextEncoder().encode(message.text)), attachments, thread: message.thread };
  }

  async function removeBlobsOf(message: StoredMessage): Promise<void> {
    for (const file of [message.text, ...message.attachments]) await blobs.remove(file.blob);
  }

  /** Runs one Source and records what it emitted; the failure, if it failed. */
  async function run(source: Source, ingestion: PollingIngestion): Promise<PollReport["failed"][number] | null> {
    const now = clock.now();
    const result = await ingestion.poll(await runContextOf(source, { secrets, now, timeZone }));
    if (!result.ok) {
      await sources.recordFailedRun(source.id, now, { kind: result.kind, message: result.message });
      return { sourceId: source.id, kind: result.kind, message: result.message };
    }
    const origins = [];
    for (const origin of result.origins) {
      origins.push({
        externalId: origin.externalId,
        occurredAt: origin.occurredAt,
        attributes: origin.attributes,
        link: origin.link,
        revisions: origin.revisions.map((revision) => checked(revision, origin.occurredAt)),
        message: origin.message ? await stored(origin.message) : null,
      });
    }
    let known: string[];
    let withdrawnFiles;
    try {
      ({ knownMessages: known, withdrawnFiles } = await items.recordRun(
        { familyId: source.familyId, sourceId: source.id, at: now, state: result.state, withdrawn: result.withdrawn, origins },
        project,
      ));
    } catch (error) {
      for (const origin of origins) if (origin.message) await removeBlobsOf(origin.message);
      throw error;
    }
    // A message seen before keeps the files it was recorded with; a withdrawn one keeps none.
    for (const origin of origins) if (origin.message && known.includes(origin.externalId)) await removeBlobsOf(origin.message);
    for (const file of withdrawnFiles) await blobs.remove(file);
    return null;
  }

  return {
    /**
     * Runs every polling Source of an enabled Source Type whose interval has passed since its last
     * run, as the worker does on each tick. A failed run waits for the next interval too.
     */
    async pollDue(): Promise<PollReport> {
      const report: PollReport = { polled: [], failed: [] };
      const enabled = new Set((await sourceTypes.list()).filter((type) => type.enabled).map((type) => type.id));
      const now = clock.now().getTime();
      const due: { source: Source; ingestion: PollingIngestion }[] = [];
      for (const type of enabled) {
        const loaded = await registry.load(type);
        if (!loaded.ok) continue;
        const { ingestion } = loaded.sourceType;
        if (ingestion.mode !== "polling") continue;
        for (const source of await sources.listOfType(type)) {
          const interval = (source.pollIntervalSeconds ?? ingestion.suggestedIntervalSeconds) * 1000;
          if (source.lastRunAt && now - source.lastRunAt.getTime() < interval) continue;
          due.push({ source, ingestion });
        }
      }
      if (due.length === 0) return report;
      const progress = await activity.begin("polling", due.length);
      try {
        for (const { source, ingestion } of due) {
          const failure = await run(source, ingestion);
          if (failure) report.failed.push(failure);
          else report.polled.push(source.id);
          await progress.advance();
        }
      } finally {
        await progress.end();
      }
      return report;
    },
  };
}

export type SourcePolling = ReturnType<typeof createSourcePolling>;
