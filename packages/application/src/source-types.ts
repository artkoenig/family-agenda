import { textIn, type SourceTypeId } from "@family-agenda/domain";
import { disableIfUnused, enableIfAllowed, type DisableResult, type Enableable, type EnableResult } from "./enablement";
import type {
  Clock,
  InstalledSourceType,
  SourceRepository,
  SourceTypeRegistry,
  SourceTypeRepository,
} from "./ports";

export type SourceTypesDeps = {
  clock: Clock;
  /** The version of Family Agenda this Instance runs, which new Source Types are recorded with. */
  applicationVersion: string;
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  sources: SourceRepository;
};

export type SourceTypeSummary = InstalledSourceType & {
  enabled: boolean;
  /** Discovered since an Admin last opened the list. */
  isNew: boolean;
  /** The application version that brought it. */
  firstSeenIn: string;
};

/** How enabling and disabling a Source Type is refused. */
const problems = { unknown: "unknown-source-type", unavailable: "not-loadable", inUse: "has-sources" } as const;

export function createSourceTypeAccess(deps: SourceTypesDeps) {
  const { clock, applicationVersion, registry, sourceTypes, sources } = deps;

  /** Brings the stored configuration of a Source Type's Sources to its plugin's version. */
  async function migrateSources(id: SourceTypeId): Promise<void> {
    const loaded = await registry.load(id);
    if (!loaded.ok) return;
    const { configuration, migrateConfig } = loaded.sourceType;
    for (const source of await sources.listOfType(id)) {
      if (source.configVersion >= configuration.version) continue;
      let plain;
      try {
        plain = migrateConfig(source.plain, source.configVersion);
      } catch {
        // The Source keeps its configuration; it fails when it runs, where its status shows it.
        continue;
      }
      await sources.migrateConfig(source.id, source.configVersion, plain, configuration.version);
    }
  }

  /**
   * A Source Type the Instance has recorded, as an Admin enables or disables it. Only an installed
   * one can be enabled: its code is loaded once its risk is acknowledged, and its Sources'
   * configuration is migrated then. One no longer installed can still be disabled.
   */
  async function enableable(id: string): Promise<Enableable | null> {
    const installed = registry.installed().find((type) => type.id === id);
    const record = (await sourceTypes.list()).find((type) => type.id === id);
    if (!record) return null;
    return {
      available: () => Promise.resolve(installed?.notLoadable === null),
      riskNotice: installed?.riskNotice ?? null,
      async enable() {
        if (!(await registry.load(record.id)).ok) return false;
        await sourceTypes.enable(record.id);
        await migrateSources(record.id);
        return true;
      },
      disableIfUnused: async () => !record.enabled || (await sourceTypes.disableIfUnused(record.id)),
    };
  }

  async function summaries(): Promise<SourceTypeSummary[]> {
    const records = new Map((await sourceTypes.list()).map((record) => [record.id, record]));
    return registry
      .installed()
      .flatMap((installed) => {
        const record = records.get(installed.id);
        return record
          ? [{ ...installed, enabled: record.enabled, isNew: record.isNew, firstSeenIn: record.firstSeenIn }]
          : [];
      })
      .sort(
        (a, b) =>
          Number(b.isNew) - Number(a.isNew) || textIn(a.displayName, "en").localeCompare(textIn(b.displayName, "en")),
      );
  }

  return {
    /**
     * At startup: records Source Types seen for the first time as new and disabled, loads the
     * enabled ones and migrates their Sources' configuration. Nothing is ever enabled here.
     */
    async start(): Promise<void> {
      const installed = registry.installed();
      await sourceTypes.recordDiscovered(installed.map((type) => type.id), applicationVersion, clock.now());
      const enabled = (await sourceTypes.list()).filter((record) => record.enabled);
      for (const record of enabled) {
        if (installed.some((type) => type.id === record.id && type.notLoadable === null)) {
          await migrateSources(record.id);
        }
      }
    },

    /** Whether the Admin area shows the "New Source Types are available" banner. */
    async hasNew(): Promise<boolean> {
      return (await summaries()).some((type) => type.isNew);
    },

    /** Every installed Source Type, new ones first, leaving the banner as it is. */
    list: summaries,

    /**
     * Every installed Source Type, new ones first, as an Admin opens the list. Opening it ends the
     * banner, so the next list shows none as new.
     */
    async open(): Promise<SourceTypeSummary[]> {
      const list = await summaries();
      if (list.some((type) => type.isNew)) await sourceTypes.markAllSeen();
      return list;
    },

    async enable(id: string, input: { riskAcknowledged?: boolean } = {}): Promise<EnableResult<typeof problems>> {
      const installed = registry.installed().some((type) => type.id === id);
      return enableIfAllowed(installed ? await enableable(id) : null, input, problems);
    },

    /** Only a Source Type without Sources can be disabled; an Admin removes those first. */
    async disable(id: string): Promise<DisableResult<typeof problems>> {
      return disableIfUnused(await enableable(id), problems);
    },
  };
}

export type SourceTypeAccess = ReturnType<typeof createSourceTypeAccess>;
