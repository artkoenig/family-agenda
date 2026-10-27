import type { SourceTypeId } from "@family-agenda/domain";
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

export type EnableResult =
  | { ok: true }
  | { ok: false; problem: "unknown-source-type" | "not-loadable" | "risk-not-acknowledged" };

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
      .sort((a, b) => Number(b.isNew) - Number(a.isNew) || a.displayName.localeCompare(b.displayName));
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

    /**
     * Every installed Source Type, new ones first, as an Admin opens the list. Opening it ends the
     * banner, so the next list shows none as new.
     */
    async open(): Promise<SourceTypeSummary[]> {
      const list = await summaries();
      if (list.some((type) => type.isNew)) await sourceTypes.markAllSeen();
      return list;
    },

    async enable(id: string, input: { riskAcknowledged?: boolean } = {}): Promise<EnableResult> {
      const installed = registry.installed().find((type) => type.id === id);
      if (!installed) return { ok: false, problem: "unknown-source-type" };
      if (installed.notLoadable !== null) return { ok: false, problem: "not-loadable" };
      if (installed.riskNotice !== null && input.riskAcknowledged !== true) {
        return { ok: false, problem: "risk-not-acknowledged" };
      }
      if (!(await registry.load(installed.id)).ok) return { ok: false, problem: "not-loadable" };
      await sourceTypes.enable(installed.id);
      await migrateSources(installed.id);
      return { ok: true };
    },

    /** Only a Source Type without Sources can be disabled; an Admin removes those first. */
    async disable(
      id: string,
    ): Promise<{ ok: true } | { ok: false; problem: "unknown-source-type" | "has-sources" }> {
      const record = (await sourceTypes.list()).find((type) => type.id === id);
      if (!record) return { ok: false, problem: "unknown-source-type" };
      if (record.enabled && !(await sourceTypes.disableIfUnused(record.id))) {
        return { ok: false, problem: "has-sources" };
      }
      return { ok: true };
    },
  };
}

export type SourceTypeAccess = ReturnType<typeof createSourceTypeAccess>;
