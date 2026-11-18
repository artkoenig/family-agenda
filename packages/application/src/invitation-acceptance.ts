import type { IdentityDirectory } from "./identity-directory";
import type { Clock } from "./ports";
import type { Registration } from "./registration-events";

/**
 * Accepts the invitation of whoever signs in, to the organization `organizationId`: resolves to
 * whether there was one, after which they are an Admin (ADR-0010).
 */
export type InvitationAcceptance = (organizationId: string, identity: { subject: string; email: string }) => Promise<boolean>;

/**
 * Admits an invitee at their first sign-in: their verified email has a pending invitation to the
 * Family's organization that has not expired, so they become a member with the role `admin` and the
 * invitation is accepted. An expired or revoked invitation admits no one. The invitee's own
 * registration is carried through first, and an Admin of another Family is admitted to none: no one
 * is an Admin of two Families.
 */
export function createInvitationAcceptance(deps: { clock: Clock; directory: IdentityDirectory; registration: Pick<Registration, "settle"> }): InvitationAcceptance {
  const { clock, directory, registration } = deps;
  return async (organizationId, identity) => {
    const email = identity.email.toLowerCase();
    const now = clock.now().getTime();
    const invitations = await directory.listInvitations(organizationId);
    const invitation = invitations.find((candidate) => candidate.email.toLowerCase() === email && candidate.expiresAt.getTime() > now);
    if (!invitation || !(await registration.settle(identity.subject))) return false;
    const organizations = await directory.organizationsOf(identity.subject);
    if (organizations?.some((id) => id !== organizationId)) return false;
    await directory.acceptInvitation(organizationId, invitation.invitationId, identity.subject);
    return true;
  };
}
