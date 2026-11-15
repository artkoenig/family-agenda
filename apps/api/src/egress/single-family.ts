import type { Application } from "../composition-root";
import type { AllowlistSources } from "./allowlist";

/**
 * The Families the allowlist answers for on an Instance that serves one (ADR-0003): its own, by its
 * id, and no other.
 */
export function singleFamily(application: Pick<Application, "familyId">): AllowlistSources["family"] {
  return (familyId) => Promise.resolve(familyId === application.familyId);
}
