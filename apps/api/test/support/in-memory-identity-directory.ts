import { randomUUID } from "node:crypto";
import type { DirectoryInvitation, DirectoryMember, IdentityDirectory, InvitationDetails } from "@family-agenda/application";

type Organization = { familyId: string; name: string; members: Map<string, DirectoryMember>; invitations: Map<string, DirectoryInvitation & { link: string; locale: string }> };

/** Keeps the organizations of an Identity Provider in memory, for tests that do not care which one it is. */
export class InMemoryIdentityDirectory implements IdentityDirectory {
  readonly organizations = new Map<string, Organization>();
  /** The users a test knows, by id: what a member listing shows of them. */
  readonly users = new Map<string, { email: string | null; lastSignInAt: Date | null }>();
  /** Whether the Identity Provider takes registrations. */
  registrationOpen = true;
  /** Fails creating an organization while set, as an Identity Provider that is down. */
  failing = false;

  /** The organization with the id, which a test expects to exist. */
  organization(organizationId: string): Organization {
    const organization = this.organizations.get(organizationId);
    if (!organization) throw new Error(`No organization ${organizationId}`);
    return organization;
  }

  createOrganization(familyId: string, name: string): Promise<string> {
    if (this.failing) return Promise.reject(new Error("the Identity Provider is down"));
    const id = randomUUID();
    this.organizations.set(id, { familyId, name, members: new Map(), invitations: new Map() });
    return Promise.resolve(id);
  }

  addMember(organizationId: string, userId: string): Promise<void> {
    const user = this.users.get(userId);
    this.organization(organizationId).members.set(userId, { userId, email: user?.email ?? null, lastSignInAt: user?.lastSignInAt ?? null });
    return Promise.resolve();
  }

  invite(organizationId: string, email: string, details: InvitationDetails): Promise<DirectoryInvitation> {
    const invitation = { invitationId: randomUUID(), email, expiresAt: details.expiresAt };
    this.organization(organizationId).invitations.set(invitation.invitationId, { ...invitation, link: details.link, locale: details.locale });
    return Promise.resolve(invitation);
  }

  listMembers(organizationId: string): Promise<DirectoryMember[]> {
    return Promise.resolve([...this.organization(organizationId).members.values()]);
  }

  removeMember(organizationId: string, userId: string): Promise<void> {
    this.organization(organizationId).members.delete(userId);
    return Promise.resolve();
  }

  listInvitations(organizationId: string): Promise<DirectoryInvitation[]> {
    return Promise.resolve([...this.organization(organizationId).invitations.values()].map(({ invitationId, email, expiresAt }) => ({ invitationId, email, expiresAt })));
  }

  revokeInvitation(organizationId: string, invitationId: string): Promise<void> {
    if (!this.organization(organizationId).invitations.delete(invitationId)) return Promise.reject(new Error(`Invitation ${invitationId} is not one of organization ${organizationId}`));
    return Promise.resolve();
  }

  wasInvited(email: string): Promise<boolean> {
    return Promise.resolve([...this.organizations.values()].some((organization) => [...organization.invitations.values()].some((invitation) => invitation.email === email)));
  }

  closeRegistration(): Promise<void> {
    this.registrationOpen = false;
    return Promise.resolve();
  }
}
