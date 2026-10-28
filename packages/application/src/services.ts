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
 * bridges (ADR-0011), started as an Admin enables them and stopped as they are disabled. The
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
      for (const { id } of registry.installed()) {
        let services = running.get(id) ?? null;
        const enabled = enabledTypes.has(id);
        if (!services && enabled) {
          const loaded = await registry.load(id);
          services = loaded.ok ? loaded.sourceType.services : null;
        }
        if (!services) continue;
        const entries = enabled ? (await catalogues.list(id)).filter((record) => record.enabled).map((record) => record.entryId) : [];
        try {
          await services.reconcile({ enabled, entries });
        } catch (error) {
          report.failed.push({ sourceTypeId: id, message: error instanceof Error ? error.message : String(error) });
        }
        if (enabled) running.set(id, services);
        else running.delete(id);
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
