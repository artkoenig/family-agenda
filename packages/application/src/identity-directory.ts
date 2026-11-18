/** The role a Family's Admins hold in its organization (ADR-0010). */
export const adminRole = "admin";

/** An Admin of a Family: a member of its organization in the Identity Provider. */
export type DirectoryMember = { userId: string; email: string | null; lastSignInAt: Date | null };

/** A pending invitation to a Family's organization; the Identity Provider mails it. */
export type DirectoryInvitation = { invitationId: string; email: string; expiresAt: Date };

/** What an invitation link signs in with (ADR-0011): the invitee's email and a one-time token for it. */
export type InvitationSignIn = { email: string; oneTimeToken: string };

/** What an invitation carries besides the invitee: when it expires, the accept link its email shows, and the language it is written in. */
export type InvitationDetails = { expiresAt: Date; link: string; locale: string };

/**
 * The Identity Provider's management API (ADR-0010): each Family is an organization, its Admins are
 * the organization's members with the role `admin`.
 */
export interface IdentityDirectory {
  /** Creates the Family's organization, its Family id kept with it; resolves to the organization id. */
  createOrganization(familyId: string, name: string): Promise<string>;
  /** The organization created for the Family id `familyId`, found by the name it was given; null for none. */
  findOrganization(familyId: string): Promise<string | null>;
  /** Deletes an organization, such as one a registration created and then had no use for. */
  deleteOrganization(organizationId: string): Promise<void>;
  /** The organizations the user is a member of; null for no such user, such as one who deleted their account. */
  organizationsOf(userId: string): Promise<string[] | null>;
  /** Makes the user a member of the organization, with the role `admin`; doing it again changes nothing. */
  addMember(organizationId: string, userId: string): Promise<void>;
  /**
   * A one-time token for `email`, valid until `expiresAt`, that the invitation link carries
   * (ADR-0011): signing in with it verifies the email and lets someone without an account create
   * one, though registration is closed. It makes no one a member; the invitation does.
   */
  createSignInToken(email: string, expiresAt: Date): Promise<string>;
  /** Invites `email` to the organization as an Admin; the Identity Provider sends the email. */
  invite(organizationId: string, email: string, details: InvitationDetails): Promise<DirectoryInvitation>;
  listMembers(organizationId: string): Promise<DirectoryMember[]>;
  removeMember(organizationId: string, userId: string): Promise<void>;
  /** The invitations still pending. */
  listInvitations(organizationId: string): Promise<DirectoryInvitation[]>;
  revokeInvitation(organizationId: string, invitationId: string): Promise<void>;
  /**
   * Accepts the pending invitation for the user `userId`: makes them a member with the role
   * `admin` and marks the invitation `Accepted`. Refuses an invitation of another organization.
   */
  acceptInvitation(organizationId: string, invitationId: string, userId: string): Promise<void>;
  /** Whether `email` was invited to any organization, pending or accepted: such a registration creates no Family (ADR-0010). */
  wasInvited(email: string): Promise<boolean>;
  /** Turns registration off, leaving only sign-in (Logto: `signInMode: SignIn`); doing it again changes nothing. */
  closeRegistration(): Promise<void>;
}

/** The management API the `IDP_MANAGEMENT_*` variables name; `logto` is the only adapter. */
export type IdentityDirectorySettings = { api: "logto"; endpoint: string; clientId: string; clientSecret: string };

/** The raw `IDP_MANAGEMENT_*` values. */
export type IdentityDirectoryInput = { api?: string | undefined; endpoint?: string | undefined; clientId?: string | undefined; clientSecret?: string | undefined };

export type IdentityDirectoryProblem = "invalid-api" | "invalid-endpoint" | "client-id-missing" | "client-secret-missing";

/**
 * The management API from its settings: none when all are absent, else all must be valid. The
 * endpoint is an http or https address without query, kept without a trailing slash.
 */
export function parseIdentityDirectorySettings(
  input: IdentityDirectoryInput,
): { ok: true; settings: IdentityDirectorySettings | null } | { ok: false; problem: IdentityDirectoryProblem } {
  if (Object.values(input).every((value) => !value)) return { ok: true, settings: null };
  const { api, endpoint, clientId, clientSecret } = input;
  if (api !== "logto") return { ok: false, problem: "invalid-api" };
  const url = endpointOf(endpoint ?? "");
  if (url === null) return { ok: false, problem: "invalid-endpoint" };
  if (!clientId) return { ok: false, problem: "client-id-missing" };
  if (!clientSecret) return { ok: false, problem: "client-secret-missing" };
  return { ok: true, settings: { api, endpoint: url, clientId, clientSecret } };
}

function endpointOf(text: string): string | null {
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  if (!/^https?:$/.test(url.protocol) || url.search + url.hash !== "") return null;
  return url.origin + url.pathname.replace(/\/+$/, ""); // eslint-disable-line sonarjs/super-linear-regex -- single-char quantifier anchored at end is O(n)
}
