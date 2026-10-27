import {
  eventOf,
  fold,
  problemsWithEventRevision,
  spanBounds,
  type FoldableRevision,
  type ItemKind,
  type SourceId,
} from "@family-butler/domain";
import type {
  Clock,
  IngestedRevision,
  ItemProjection,
  ItemRepository,
  NewRevision,
  PollingIngestion,
  SecretStore,
  Source,
  SourceRepository,
  SourceTypeRegistry,
  SourceTypeRepository,
} from "./ports";

export type PollingDeps = {
  clock: Clock;
  /** The IANA time zone the Family lives in, which plugins read times without a zone in. */
  timeZone: string;
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  sources: SourceRepository;
  secrets: SecretStore;
  items: ItemRepository;
};

export type PollReport = {
  /** The Sources run successfully. */
  polled: SourceId[];
  failed: { sourceId: SourceId; kind: "definite" | "temporary"; message: string }[];
};

export function createSourcePolling(deps: PollingDeps) {
  const { clock, timeZone, registry, sourceTypes, sources, secrets, items } = deps;

  /** Runs one Source and records what it emitted; the failure, if it failed. */
  async function run(source: Source, ingestion: PollingIngestion): Promise<PollReport["failed"][number] | null> {
    const now = clock.now();
    const secretValues: Record<string, string> = {};
    for (const [key, ref] of Object.entries(source.secrets)) {
      const value = await secrets.get(ref);
      if (value !== null) secretValues[key] = value;
    }
    const result = await ingestion.poll({ plain: source.plain, secrets: secretValues, state: source.state, now, timeZone });
    if (!result.ok) {
      await sources.recordFailedRun(source.id, now);
      return { sourceId: source.id, kind: result.kind, message: result.message };
    }
    await items.recordRun(
      {
        familyId: source.familyId,
        sourceId: source.id,
        at: now,
        state: result.state,
        origins: result.origins.map((origin) => ({
          externalId: origin.externalId,
          attributes: origin.attributes,
          link: origin.link,
          revisions: origin.revisions.map((revision) => checked(revision, origin.occurredAt)),
        })),
      },
      project,
    );
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
      for (const type of enabled) {
        const loaded = await registry.load(type);
        if (!loaded.ok) continue;
        const { ingestion } = loaded.sourceType;
        if (ingestion.mode !== "polling") continue;
        for (const source of await sources.listOfType(type)) {
          const interval = (source.pollIntervalSeconds ?? ingestion.suggestedIntervalSeconds) * 1000;
          if (source.lastRunAt && now - source.lastRunAt.getTime() < interval) continue;
          const failure = await run(source, ingestion);
          if (failure) report.failed.push(failure);
          else report.polled.push(source.id);
        }
      }
      return report;
    },
  };
}

export type SourcePolling = ReturnType<typeof createSourcePolling>;

/**
 * A Revision as it is appended: rejected automatically if its fields cannot apply. Only Events
 * have their fields defined yet; the other kinds come with their own tickets.
 */
function checked(revision: IngestedRevision, sourceTime: Date): NewRevision {
  const accepted =
    revision.itemKind !== "event" || problemsWithEventRevision(revision.act, revision.fields).length === 0;
  return { ...revision, sourceTime, accepted };
}

/** What an Item's Revisions add up to, and the time it can be found by. */
function project(kind: ItemKind, revisions: FoldableRevision[]): ItemProjection {
  const folded = fold(revisions);
  const event = kind === "event" ? eventOf(folded) : null;
  return { folded, window: event ? spanBounds(event.span) : null };
}
