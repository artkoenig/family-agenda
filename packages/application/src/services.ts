import type { SourceTypeId } from "@family-agenda/domain";
import type { CatalogueRepository, ServicesSpec, SourceTypeRegistry, SourceTypeRepository } from "./ports";

export type ServiceSupervisionDeps = {
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  catalogues: CatalogueRepository;
};

export type ServiceReport = { failed: { sourceTypeId: SourceTypeId; message: string }[] };

/**
 * The programs Source Types run on the Instance, such as the Matrix plugin's homeserver and
 * bridges, started as an Admin enables them and stopped as they are disabled. The
 * worker reconciles them every few seconds, so that enabling a Messenger is all it takes.
 */
export function createServiceSupervision(deps: ServiceSupervisionDeps) {
  const { registry, sourceTypes, catalogues } = deps;
  /** The services reconciled as enabled, which are told once their Source Type is disabled. */
  const running = new Map<SourceTypeId, ServicesSpec>();

  return {
    async reconcile(): Promise<ServiceReport> {
      const report: ServiceReport = { failed: [] };
      const enabledTypes = new Set((await sourceTypes.list()).filter((type) => type.enabled).map((type) => type.id));
      const resolveServices = async (id: SourceTypeId): Promise<ServicesSpec | null> => {
        let services = running.get(id) ?? null;
        if (!services && enabledTypes.has(id)) {
          const loaded = await registry.load(id);
          services = loaded.ok ? loaded.sourceType.services : null;
        }
        return services;
      };
      const enabledEntries = async (id: SourceTypeId): Promise<string[]> => {
        if (!enabledTypes.has(id)) return [];
        return (await catalogues.list(id)).filter((record) => record.enabled).map((record) => record.entryId);
      };
      const reconcileOne = async (id: SourceTypeId): Promise<void> => {
        const services = await resolveServices(id);
        if (!services) return;
        const entries = await enabledEntries(id);
        try {
          await services.reconcile({ enabled: enabledTypes.has(id), entries });
        } catch (error) {
          report.failed.push({ sourceTypeId: id, message: error instanceof Error ? error.message : String(error) });
        }
        if (enabledTypes.has(id)) running.set(id, services);
        else running.delete(id);
      };
      for (const { id } of registry.installed()) {
        await reconcileOne(id);
      }
      return report;
    },

    /** Stops every service, as the worker shuts down. */
    async stop(): Promise<void> {
      const stopping = [...running.values()].map((services) => services.stop().catch(() => undefined));
      running.clear();
      await Promise.all(stopping);
    },
  };
}

export type ServiceSupervision = ReturnType<typeof createServiceSupervision>;
