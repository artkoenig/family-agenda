import { textIn, type MultilingualText, type SourceTypeId } from "@family-agenda/domain";
import type {
  CatalogueEntrySpec,
  CatalogueRepository,
  Clock,
  LoadedSourceType,
  SourceRepository,
  SourceTypeRegistry,
  SourceTypeRepository,
} from "./ports";
import { enabledSourceType } from "./enabled-source-type";

export type CataloguesDeps = {
  clock: Clock;
  /** The version of Family Agenda this Instance runs, which new entries are recorded with. */
  applicationVersion: string;
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  catalogues: CatalogueRepository;
  sources: SourceRepository;
};

export type CatalogueEntrySummary = CatalogueEntrySpec & {
  enabled: boolean;
  /** The application version that brought it. */
  firstSeenIn: string;
};

/** The catalogue of an enabled Source Type, such as the Messengers of the Matrix plugin (ADR-0011). */
export type CatalogueSummary = {
  sourceTypeId: SourceTypeId;
  title: MultilingualText;
  entries: CatalogueEntrySummary[];
};

export type CatalogueProblem = "unknown-entry" | "not-installed" | "risk-not-acknowledged" | "entry-in-use";

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
  return (await sourceType.catalogue.entries()).filter((entry) => entry.installed && enabled.has(entry.id));
}

/**
 * What an Admin enables within a Source Type, one entry at a time. Installed is not enabled, as
 * for Source Types (ADR-0010): an entry seen for the first time is recorded disabled, also after an
 * update, and one that a Source uses cannot be disabled.
 */
export function createCatalogueAccess(deps: CataloguesDeps) {
  const { clock, applicationVersion, registry, sourceTypes, catalogues, sources } = deps;

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
    const entries = await catalogue.entries();
    await catalogues.recordDiscovered(id, entries.map((entry) => entry.id), applicationVersion, clock.now());
    const records = new Map((await catalogues.list(id)).map((record) => [record.entryId, record]));
    return {
      sourceTypeId: id,
      title: catalogue.title,
      entries: entries
        .flatMap((entry) => {
          const record = records.get(entry.id);
          return record ? [{ ...entry, enabled: record.enabled, firstSeenIn: record.firstSeenIn }] : [];
        })
        .sort((a, b) => textIn(a.displayName, "en").localeCompare(textIn(b.displayName, "en"))),
    };
  }

  async function entryOf(sourceTypeId: string, entryId: string) {
    const found = (await withCatalogues()).find((candidate) => candidate.id === sourceTypeId);
    if (!found) return null;
    const { catalogue } = found.sourceType;
    const summary = await summaryOf(found.id, found.sourceType);
    const entry = summary?.entries.find((candidate) => candidate.id === entryId);
    return catalogue && entry ? { id: found.id, configKey: catalogue.configKey, entry } : null;
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
    ): Promise<{ ok: true } | { ok: false; problem: CatalogueProblem }> {
      const found = await entryOf(sourceTypeId, entryId);
      if (!found) return { ok: false, problem: "unknown-entry" };
      if (!found.entry.installed) return { ok: false, problem: "not-installed" };
      if (found.entry.riskNotice !== null && input.riskAcknowledged !== true) {
        return { ok: false, problem: "risk-not-acknowledged" };
      }
      await catalogues.setEnabled(found.id, entryId, true);
      return { ok: true };
    },

    /** Only an entry no Source uses can be disabled; an Admin removes those Sources first. */
    async disable(sourceTypeId: string, entryId: string): Promise<{ ok: true } | { ok: false; problem: CatalogueProblem }> {
      const found = await entryOf(sourceTypeId, entryId);
      if (!found) return { ok: false, problem: "unknown-entry" };
      const used = (await sources.listOfType(found.id)).some((source) => source.plain[found.configKey] === entryId);
      if (used) return { ok: false, problem: "entry-in-use" };
      await catalogues.setEnabled(found.id, entryId, false);
      return { ok: true };
    },
  };
}

export type CatalogueAccess = ReturnType<typeof createCatalogueAccess>;
