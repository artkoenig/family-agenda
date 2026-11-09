import { sourceStatus, type SourceStatus } from "@family-agenda/domain";
import type { Clock, Source, SourceRepository, SourceTypeRegistry, SourceTypeRepository } from "./ports";
import { enabledSourceType } from "./enabled-source-type";

/** Why a Source is not OK, or why its last run failed. */
export type HealthProblem =
  | { kind: "run-failed"; message: string }
  /** Its plugin was removed; its Source Records and Items stay, and it resumes once reinstalled. */
  | { kind: "not-installed" }
  /** Installed, but its code cannot be loaded; `reason` is null when the registry gives none. */
  | { kind: "not-loadable"; reason: string | null };

export type SourceHealth = {
  status: SourceStatus;
  /** The last error of a Source whose last run failed, even while it is still OK; null otherwise. */
  problem: HealthProblem | null;
  lastSuccessAt: Date | null;
  /**
   * A warning beside the status: the external ids of Source Records whose stated Item was invalid,
   * so that none was written.
   */
  invalidRecords: string[];
  /**
   * A warning beside the status: the Source Attribute ids that Source Records named without their
   * being declared, or after they were archived, so that those were refused. A plugin bug.
   */
  unknownAttributes: string[];
};

export type SourceHealthDeps = {
  clock: Clock;
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  sources: SourceRepository;
};

/** How a Source is doing, as the Admin area shows it (ADR-0001). */
export async function healthOf(source: Source, deps: SourceHealthDeps): Promise<SourceHealth> {
  const { lastSuccessAt, failure, invalidRecords, unknownAttributes } = source;
  const loaded = await enabledSourceType(source.sourceTypeId, deps);
  if (!loaded) {
    const installed = deps.registry.installed().find((type) => type.id === source.sourceTypeId);
    const problem: HealthProblem = installed
      ? { kind: "not-loadable", reason: installed.notLoadable }
      : { kind: "not-installed" };
    return { status: "failing", problem, lastSuccessAt, invalidRecords, unknownAttributes };
  }
  const status = sourceStatus({
    failure,
    silentApplies: loaded.silentApplies,
    lastNewRecordAt: source.lastNewRecordAt,
    createdAt: source.createdAt,
    now: deps.clock.now(),
  });
  return { status, problem: failure ? { kind: "run-failed", message: failure.message } : null, lastSuccessAt, invalidRecords, unknownAttributes };
}

/** Whether the Family's Sources work, as every Agenda hints at without detail. */
export function createSourceHealth(deps: SourceHealthDeps) {
  return {
    /** Whether any of the Family's Sources is Failing. */
    async anyFailing(): Promise<boolean> {
      for (const source of await deps.sources.list()) {
        if ((await healthOf(source, deps)).status === "failing") return true;
      }
      return false;
    },
  };
}

export type SourceHealthCheck = ReturnType<typeof createSourceHealth>;
