import { textIn, type MultilingualText, type SourceTypeId } from "@family-agenda/domain";
import { valueOr } from "./ports";
import type {
  CatalogueEntrySpec,
  CatalogueRepository,
  LoadedSourceType,
  SourceTypeRegistry,
  SourceTypeRepository,
} from "./ports";
import { enabledSourceType } from "./enabled-source-type";
import { isPollInterval } from "./poll-interval";
import { disableIfUnused, enableIfAllowed, type DisableResult, type Enableable, type EnableResult } from "./enablement";

export type CataloguesDeps = {
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  catalogues: CatalogueRepository;
};

export type CatalogueEntrySummary = CatalogueEntrySpec & {
  enabled: boolean;
  /** How often the Sources using it are polled; null for their plugin's suggestion. */
  pollIntervalSeconds: number | null;
};

/** The catalogue of an enabled Source Type, such as the Messengers of the Matrix plugin (ADR-0011). */
export type CatalogueSummary = {
  sourceTypeId: SourceTypeId;
  title: MultilingualText;
  entries: CatalogueEntrySummary[];
  /** Why asking the plugin for the entries failed; null if it answered. */
  problem: string | null;
};

/** How enabling and disabling an entry is refused. */
const problems = { unknown: "unknown-entry", unavailable: "not-installed", inUse: "entry-in-use" } as const;


/**
 * The entries of a catalogue that a Source can use: enabled by an Admin, and installed. An entry
 * whose bridge is gone stays enabled, but is not offered.
 */
export async function usableEntries(
  sourceTypeId: SourceTypeId,
  sourceType: LoadedSourceType,
  catalogues: CatalogueRepository,
): Promise<CatalogueEntrySpec[]> {
  if (!sourceType.catalogue) return [];
  const enabled = new Set((await catalogues.list(sourceTypeId)).filter((record) => record.enabled).map((record) => record.entryId));
  // The Source form offers no entries then; the Source Type page shows why (`CatalogueSummary.problem`).
  return valueOr(await sourceType.catalogue.entries(), []).filter((entry) => entry.installed && enabled.has(entry.id));
}

/**
 * What an Admin enables within a Source Type, one entry at a time. Installed is not enabled, as
 * for Source Types (ADR-0010): an entry seen for the first time is recorded disabled, also after an
 * update, and one that a Source uses cannot be disabled.
 */
export function createCatalogueAccess(deps: CataloguesDeps) {
  const { registry, sourceTypes, catalogues } = deps;

  /** The enabled Source Types that have a catalogue, with their plugins. */
  async function withCatalogues(): Promise<{ id: SourceTypeId; sourceType: LoadedSourceType }[]> {
    const found = [];
    for (const type of registry.installed()) {
      const sourceType = await enabledSourceType(type.id, { registry, sourceTypes });
      if (sourceType?.catalogue) found.push({ id: type.id, sourceType });
    }
    return found;
  }

  /** The catalogue as the plugin lists it now, its new entries recorded as disabled. */
  async function summaryOf(id: SourceTypeId, sourceType: LoadedSourceType): Promise<CatalogueSummary | null> {
    const { catalogue } = sourceType;
    if (!catalogue) return null;
    const answer = await catalogue.entries();
    const entries = valueOr(answer, []);
    // A plugin that failed to answer discovered nothing.
    if (answer.ok) await catalogues.recordDiscovered(id, entries.map((entry) => entry.id));
    const records = new Map((await catalogues.list(id)).map((record) => [record.entryId, record]));
    return {
      sourceTypeId: id,
      title: catalogue.title,
      problem: answer.ok ? null : answer.message,
      entries: entries
        .flatMap((entry) => {
          const record = records.get(entry.id);
          return record
            ? [{ ...entry, enabled: record.enabled, pollIntervalSeconds: record.pollIntervalSeconds }]
            : [];
        })
        .sort((a, b) => textIn(a.displayName, "en").localeCompare(textIn(b.displayName, "en"))),
    };
  }

  /** An entry of an enabled Source Type's catalogue, as an Admin enables or disables it. */
  async function enableable(sourceTypeId: string, entryId: string): Promise<Enableable | null> {
    const found = (await withCatalogues()).find((candidate) => candidate.id === sourceTypeId);
    if (!found) return null;
    const { catalogue } = found.sourceType;
    const summary = await summaryOf(found.id, found.sourceType);
    const entry = summary?.entries.find((candidate) => candidate.id === entryId);
    if (!catalogue || !entry) return null;
    return {
      available: () => Promise.resolve(entry.installed),
      riskNotice: entry.riskNotice,
      async enable() {
        await catalogues.enable(found.id, entryId);
        return true;
      },
      disableIfUnused: () => catalogues.disableIfUnused(found.id, entryId, catalogue.configKey),
    };
  }

  return {
    /** At startup: records the entries seen for the first time as disabled. Nothing is ever enabled here. */
    async start(): Promise<void> {
      for (const { id, sourceType } of await withCatalogues()) await summaryOf(id, sourceType);
    },

    /** The catalogues of the enabled Source Types, as an Admin opens them. */
    async list(): Promise<CatalogueSummary[]> {
      const summaries: CatalogueSummary[] = [];
      for (const { id, sourceType } of await withCatalogues()) {
        const summary = await summaryOf(id, sourceType);
        if (summary) summaries.push(summary);
      }
      return summaries;
    },

    /** Enables an installed entry; one with a risk notice only once an Admin acknowledged it. */
    async enable(
      sourceTypeId: string,
      entryId: string,
      input: { riskAcknowledged?: boolean } = {},
    ): Promise<EnableResult<typeof problems>> {
      return enableIfAllowed(await enableable(sourceTypeId, entryId), input, problems);
    },

    /**
     * Sets how often the Sources using an entry are polled, such as all WhatsApp accounts; null
     * returns them to their plugin's suggestion.
     */
    async setPollInterval(
      sourceTypeId: string,
      entryId: string,
      seconds: number | null,
    ): Promise<{ ok: true } | { ok: false; problem: "unknown-entry" | "invalid-interval" }> {
      const found = (await withCatalogues()).find((candidate) => candidate.id === sourceTypeId);
      const summary = found ? await summaryOf(found.id, found.sourceType) : null;
      if (!found || !summary?.entries.some((entry) => entry.id === entryId)) return { ok: false, problem: "unknown-entry" };
      if (!isPollInterval(seconds)) return { ok: false, problem: "invalid-interval" };
      await catalogues.setPollInterval(found.id, entryId, seconds);
      return { ok: true };
    },

    /** Only an entry no Source uses can be disabled; an Admin removes those Sources first. */
    async disable(sourceTypeId: string, entryId: string): Promise<DisableResult<typeof problems>> {
      return disableIfUnused(await enableable(sourceTypeId, entryId), problems);
    },
  };
}

export type CatalogueAccess = ReturnType<typeof createCatalogueAccess>;
