import type { SourceId, SourceTypeId } from "@family-agenda/domain";
import type { Application } from "../composition-root";
import type { AllowlistSources } from "./allowlist";

/**
 * The Families the allowlist answers for on an Instance that serves one (ADR-0003): its own, by its
 * id, and no other.
 */
export function singleFamily(application: Pick<Application, "familyId" | "egressHosts">): AllowlistSources["family"] {
  const own = {
    hostsOf: (sourceId: string, sourceTypeId: string) => application.egressHosts.ofSource(sourceId as SourceId, sourceTypeId as SourceTypeId),
  };
  return (familyId) => Promise.resolve(familyId === application.familyId ? own : null);
}
