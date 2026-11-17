import type { FamilyLanguage } from "@family-agenda/domain";
import type { DirectoryInvitation, DirectoryMember, IdentityDirectory } from "./identity-directory";
import type { Clock, FamilyRepository } from "./ports";

/** How long an invitation's accept link stays valid (ADR-0010). */
export const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export type FamilyAdminsDeps = {
  clock: Clock;
  families: Pick<FamilyRepository, "organizationId">;
  /** Null without a management API: then there is no Admins page. */
  directory: IdentityDirectory | null;
  familyLanguage: () => Promise<FamilyLanguage>;
};

export type AdminsListing = { admins: DirectoryMember[]; invitations: DirectoryInvitation[] };

export type InvitationResult = { ok: true } | { ok: false; problem: "invalid-email" | "already-admin" | "already-invited" };

export type RemovalResult = { ok: true } | { ok: false; problem: "last-admin" };

/** A plausible email address: something, an `@`, a domain with a dot; no spaces. */
const emailPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * The Family's Admins, kept in the Identity Provider as members of its organization (ADR-0010):
 * listed, invited by email and removed through the management API, the last one never.
 */
export function createFamilyAdmins(deps: FamilyAdminsDeps) {
  const { clock, families, directory, familyLanguage } = deps;

  /** The organization the page manages; null without a management API or before registration created it. */
  const organizationOf = async (): Promise<{ directory: IdentityDirectory; organizationId: string } | null> => {
    if (directory === null) return null;
    const organizationId = await families.organizationId();
    return organizationId === null ? null : { directory, organizationId };
  };

  const listingOf = async (directory: IdentityDirectory, organizationId: string): Promise<AdminsListing> => ({
    admins: await directory.listMembers(organizationId),
    invitations: await directory.listInvitations(organizationId),
  });

  return {
    /** Whether the Admin area shows the Admins page. */
    async isOffered(): Promise<boolean> {
      return (await organizationOf()) !== null;
    },

    /** The Admins and the pending invitations; null when the page is not offered. */
    async list(): Promise<AdminsListing | null> {
      const at = await organizationOf();
      return at && listingOf(at.directory, at.organizationId);
    },

    /** Invites `email` as an Admin; the Identity Provider mails `link` in the Family Language, valid for 7 days. */
    async invite(email: string, link: string): Promise<InvitationResult> {
      const at = await organizationOf();
      if (at === null) throw new Error("No Admins page without the Family's organization in a management API");
      const invitee = email.trim().toLowerCase();
      if (!emailPattern.test(invitee)) return { ok: false, problem: "invalid-email" };
      const { admins, invitations } = await listingOf(at.directory, at.organizationId);
      if (admins.some((admin) => admin.email?.toLowerCase() === invitee)) return { ok: false, problem: "already-admin" };
      if (invitations.some((invitation) => invitation.email.toLowerCase() === invitee)) return { ok: false, problem: "already-invited" };
      const expiresAt = new Date(clock.now().getTime() + invitationLifetimeMs);
      await at.directory.invite(at.organizationId, invitee, { expiresAt, link, locale: await familyLanguage() });
      return { ok: true };
    },

    async revoke(invitationId: string): Promise<void> {
      const at = await organizationOf();
      if (at !== null) await at.directory.revokeInvitation(at.organizationId, invitationId);
    },

    /** Removes the Admin `userId`, unless it is the last one; it takes effect at their next sign-in. */
    async remove(userId: string): Promise<RemovalResult> {
      const at = await organizationOf();
      if (at === null) return { ok: true };
      const admins = await at.directory.listMembers(at.organizationId);
      if (!admins.some((admin) => admin.userId === userId)) return { ok: true };
      if (admins.length <= 1) return { ok: false, problem: "last-admin" };
      await at.directory.removeMember(at.organizationId, userId);
      return { ok: true };
    },
  };
}

export type FamilyAdmins = ReturnType<typeof createFamilyAdmins>;
