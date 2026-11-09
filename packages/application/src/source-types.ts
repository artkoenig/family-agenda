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
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  sources: SourceRepository;
  clock: Clock;
};

export type SourceTypeSummary = InstalledSourceType & { enabled: boolean };

/** How enabling and disabling a Source Type is refused. */
const problems = { unknown: "unknown-source-type", unavailable: "not-loadable", inUse: "has-sources" } as const;

export function createSourceTypeAccess(deps: SourceTypesDeps) {
  const { registry, sourceTypes, sources, clock } = deps;

  /** Brings the stored configuration of a Source Type's Sources to its plugin's version. */
  async function migrateSources(id: SourceTypeId): Promise<void> {
    const loaded = await registry.load(id);
    if (!loaded.ok) return;
    const { configuration, migrateConfig } = loaded.sourceType;
    for (const source of await sources.listOfType(id)) {
      if (source.configVersion >= configuration.version) continue;
      let plain;
      try {
        plain = await migrateConfig(source.plain, source.configVersion);
      } catch (error) {
        // The Source keeps its configuration; its status shows why, as for a failed run.
        const message = error instanceof Error ? error.message : String(error);
        await sources.recordFailedRun(source.id, clock.now(), { kind: "definite", message });
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
        return record ? [{ ...installed, enabled: record.enabled }] : [];
      })
      .sort((a, b) => textIn(a.displayName, "en").localeCompare(textIn(b.displayName, "en")));
  }

  return {
    /**
     * At startup: records Source Types seen for the first time as disabled, loads the
     * enabled ones and migrates their Sources' configuration. Nothing is ever enabled here.
     */
    async start(): Promise<void> {
      const installed = registry.installed();
      await sourceTypes.recordDiscovered(installed.map((type) => type.id));
      const enabled = (await sourceTypes.list()).filter((record) => record.enabled);
      for (const record of enabled) {
        if (installed.some((type) => type.id === record.id && type.notLoadable === null)) {
          await migrateSources(record.id);
        }
      }
    },

    /** Every installed Source Type the Instance has recorded, by name. */
    list: summaries,

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
