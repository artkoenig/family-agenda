import type { IdentityDirectory } from "./identity-directory";
import type { FamilyRepository } from "./ports";
import type { Registration, RegistrationEvent } from "./registration-events";

/** The name the Family's organization gets in the Identity Provider. */
export const organizationName = "Family Agenda";

export type FamilyRegistrationDeps = {
  families: Pick<FamilyRepository, "familyId" | "organizationId" | "recordOrganizationId">;
  directory: IdentityDirectory;
};

/**
 * Registration in fixed mode (ADR-0010): the first registration creates the one Family's
 * organization, records it, makes the user its first Admin and closes registration in the Identity
 * Provider. A later one creates nothing; registration closes again in case it slipped through.
 */
export function createFamilyRegistration(deps: FamilyRegistrationDeps): Registration {
  const { families, directory } = deps;
  // Once a Family exists, registration never reopens: no need to ask the database again.
  let closed = false;
  const isOpen = async (): Promise<boolean> => {
    closed ||= (await families.organizationId()) !== null;
    return !closed;
  };

  async function createFamilyOf(event: RegistrationEvent): Promise<void> {
    const organizationId = await directory.createOrganization(await families.familyId(), organizationName);
    // Members first: once the organization is recorded, a retry would create nothing.
    await directory.addMember(organizationId, event.userId);
    // Another registration at the same moment may have won; its organization is the Family's.
    if (await families.recordOrganizationId(organizationId)) return;
    await directory.removeMember(organizationId, event.userId);
  }

  return {
    isOpen,
    async register(event) {
      if (await isOpen()) await createFamilyOf(event);
      await directory.closeRegistration();
    },
  };
}
