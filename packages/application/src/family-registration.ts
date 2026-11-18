import type { IdentityDirectory } from "./identity-directory";
import type { Clock, FamilyRepository } from "./ports";
import { createRegistrationInbox, type RegistrationInboxRepository, type RegistrationMode } from "./registration-inbox";
import type { Registration } from "./registration-events";

export type FamilyRegistrationDeps = {
  clock: Clock;
  families: Pick<FamilyRepository, "familyId" | "organizationId" | "recordOrganizationId">;
  registrations: RegistrationInboxRepository;
  directory: IdentityDirectory;
};

/**
 * Registration in fixed mode (ADR-0010): the first registration creates the one Family's
 * organization, records it, makes the user its first Admin and closes registration in the Identity
 * Provider. A later one creates nothing; registration closes again in case it slipped through. One
 * registration is carried at a time, so that only the first creates anything.
 */
export function createFamilyRegistration(deps: FamilyRegistrationDeps): Registration {
  const { clock, families, registrations, directory } = deps;
  // Once a Family exists, registration never reopens: no need to ask the database again.
  let closed = false;
  const isOpen = async (): Promise<boolean> => {
    closed ||= (await families.organizationId()) !== null;
    return !closed;
  };

  const mode: RegistrationMode = {
    isOpen,
    alone: true,
    familyIdOf: () => families.familyId(),
    async createsNothing(registration) {
      const recorded = await families.organizationId();
      return recorded !== null && recorded !== registration.organizationId;
    },
    nothing: () => directory.closeRegistration(),
    async finish(registration, organizationId) {
      // A core of an older version may have registered at the same moment; its organization is the Family's.
      if (!(await families.recordOrganizationId(organizationId)) && (await families.organizationId()) !== organizationId) {
        await directory.removeMember(organizationId, registration.userId);
      }
      await directory.closeRegistration();
    },
  };

  return createRegistrationInbox({ clock, registrations, directory, mode });
}
