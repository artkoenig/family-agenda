import { randomUUID } from "node:crypto";
import type { DirectoryInvitation, DirectoryMember, IdentityDirectory, InvitationDetails } from "@family-agenda/application";

type SentInvitation = DirectoryInvitation & { link: string; locale: string };
type Organization = { familyId: string; name: string; members: Map<string, DirectoryMember>; invitations: Map<string, SentInvitation>; accepted: SentInvitation[] };

/** Keeps the organizations of an Identity Provider in memory, for tests that do not care which one it is. */
export class InMemoryIdentityDirectory implements IdentityDirectory {
  readonly organizations = new Map<string, Organization>();
  /** The users a test knows, by id: what a member listing shows of them. */
  readonly users = new Map<string, { email: string | null; lastSignInAt: Date | null }>();
  /** Whether the Identity Provider takes registrations. */
  registrationOpen = true;
  /** Fails creating an organization while set, as an Identity Provider that is down. */
  failing = false;
  /** Fails adding a member while set, as an Identity Provider that goes down midway. */
  failingToAdd = false;
  /** The users who deleted their account. */
  readonly deleted = new Set<string>();

  /** The organization with the id, which a test expects to exist. */
  organization(organizationId: string): Organization {
    const organization = this.organizations.get(organizationId);
    if (!organization) throw new Error(`No organization ${organizationId}`);
    return organization;
  }

  createOrganization(familyId: string, name: string): Promise<string> {
    if (this.failing) return Promise.reject(new Error("the Identity Provider is down"));
    const id = randomUUID();
    this.organizations.set(id, { familyId, name, members: new Map(), invitations: new Map(), accepted: [] });
    return Promise.resolve(id);
  }

  findOrganization(familyId: string): Promise<string | null> {
    const found = [...this.organizations.entries()].find(([, organization]) => organization.familyId === familyId);
    return Promise.resolve(found?.[0] ?? null);
  }

  deleteOrganization(organizationId: string): Promise<void> {
    this.organizations.delete(organizationId);
    return Promise.resolve();
  }

  organizationsOf(userId: string): Promise<string[] | null> {
    if (this.deleted.has(userId)) return Promise.resolve(null);
    return Promise.resolve([...this.organizations.entries()].filter(([, organization]) => organization.members.has(userId)).map(([id]) => id));
  }

  organizationsOfEmail(email: string): Promise<string[]> {
    const users = [...this.users.entries()].filter(([, user]) => user.email?.toLowerCase() === email.toLowerCase()).map(([id]) => id);
    return Promise.resolve([...this.organizations.entries()].filter(([, organization]) => users.some((id) => organization.members.has(id))).map(([id]) => id));
  }

  addMember(organizationId: string, userId: string): Promise<void> {
    if (this.failingToAdd) return Promise.reject(new Error("the Identity Provider went down"));
    const user = this.users.get(userId);
    this.organization(organizationId).members.set(userId, { userId, email: user?.email ?? null, lastSignInAt: user?.lastSignInAt ?? null });
    return Promise.resolve();
  }

  /** The one-time tokens handed out, by token. */
  readonly signInTokens = new Map<string, { email: string; expiresAt: Date }>();

  createSignInToken(email: string, expiresAt: Date): Promise<string> {
    const token = `ott-${randomUUID()}`;
    this.signInTokens.set(token, { email, expiresAt });
    return Promise.resolve(token);
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

  acceptInvitation(organizationId: string, invitationId: string, userId: string): Promise<void> {
    const organization = this.organization(organizationId);
    const invitation = organization.invitations.get(invitationId);
    if (!invitation) return Promise.reject(new Error(`Invitation ${invitationId} is not one of organization ${organizationId}`));
    organization.invitations.delete(invitationId);
    organization.accepted.push(invitation);
    return this.addMember(organizationId, userId);
  }

  wasInvited(email: string): Promise<boolean> {
    return Promise.resolve(
      [...this.organizations.values()].some((organization) => [...organization.invitations.values(), ...organization.accepted].some((invitation) => invitation.email === email)),
    );
  }

  closeRegistration(): Promise<void> {
    this.registrationOpen = false;
    return Promise.resolve();
  }
}
