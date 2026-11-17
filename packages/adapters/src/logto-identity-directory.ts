import {
  adminRole,
  type DirectoryInvitation,
  type DirectoryMember,
  type IdentityDirectory,
  type IdentityDirectorySettings,
  type InvitationDetails,
} from "@family-agenda/application";

/** The resource indicator of a self-hosted Logto's Management API. */
export const defaultLogtoManagementResource = "https://default.logto.app/api";

/** The scope and ID token claim of a Logto user's organizations, which sign-in checks with a management API (ADR-0010). */
export const logtoOrganizations = { scope: "urn:logto:scope:organizations", claim: "organizations" } as const;

/** How many members one page of Logto's list holds, its largest. */
const pageSize = 100;

/** A token is fetched again this long before it expires. */
const tokenMargin = 60_000;

type LogtoUser = { id: string; primaryEmail?: string | null; lastSignInAt?: number | null };
type LogtoInvitation = { id: string; invitee: string; expiresAt: number; status: string; organizationId: string };

const invitationOf = (invitation: LogtoInvitation): DirectoryInvitation => ({
  invitationId: invitation.id,
  email: invitation.invitee,
  expiresAt: new Date(invitation.expiresAt),
});

export type LogtoIdentityDirectoryOptions = {
  /** The Management API's resource indicator; a self-hosted Logto's by default. */
  resource?: string;
  /** The clock a token's expiry is checked against. */
  now?: () => number;
};

/**
 * Logto's Management API (ADR-0010): a Family is an Organization, its Admins its members with the
 * organization role `admin`. Signs in as a machine-to-machine application with client credentials.
 */
export class LogtoIdentityDirectory implements IdentityDirectory {
  private token: { value: string; expiresAt: number } | null = null;
  private adminRoleId: string | null = null;
  private readonly resource: string;
  private readonly now: () => number;

  constructor(
    private readonly settings: IdentityDirectorySettings,
    options: LogtoIdentityDirectoryOptions = {},
  ) {
    this.resource = options.resource ?? defaultLogtoManagementResource;
    this.now = options.now ?? Date.now;
  }

  async createOrganization(familyId: string, name: string): Promise<string> {
    const organization = await this.call<{ id: string }>("POST", "/api/organizations", { name, customData: { familyId } });
    return organization.id;
  }

  async addMember(organizationId: string, userId: string): Promise<void> {
    const path = `/api/organizations/${encodeURIComponent(organizationId)}/users`;
    await this.call("POST", path, { userIds: [userId] });
    await this.call("POST", `${path}/${encodeURIComponent(userId)}/roles`, { organizationRoleIds: [await this.adminRoleIdOf()] });
  }

  async invite(organizationId: string, email: string, details: InvitationDetails): Promise<DirectoryInvitation> {
    const invitation = await this.call<LogtoInvitation>("POST", "/api/organization-invitations", {
      invitee: email,
      organizationId,
      expiresAt: details.expiresAt.getTime(),
      organizationRoleIds: [await this.adminRoleIdOf()],
      messagePayload: { link: details.link, locale: details.locale },
    });
    return invitationOf(invitation);
  }

  async listMembers(organizationId: string): Promise<DirectoryMember[]> {
    const members: DirectoryMember[] = [];
    for (let page = 1; ; page++) {
      const users = await this.call<LogtoUser[]>(
        "GET",
        `/api/organizations/${encodeURIComponent(organizationId)}/users?page=${page}&page_size=${pageSize}`,
      );
      members.push(
        ...users.map((user) => ({
          userId: user.id,
          email: user.primaryEmail ?? null,
          lastSignInAt: user.lastSignInAt ? new Date(user.lastSignInAt) : null,
        })),
      );
      if (users.length < pageSize) return members;
    }
  }

  async removeMember(organizationId: string, userId: string): Promise<void> {
    await this.call("DELETE", `/api/organizations/${encodeURIComponent(organizationId)}/users/${encodeURIComponent(userId)}`);
  }

  async listInvitations(organizationId: string): Promise<DirectoryInvitation[]> {
    const invitations = await this.call<LogtoInvitation[]>(
      "GET",
      `/api/organization-invitations?organizationId=${encodeURIComponent(organizationId)}`,
    );
    return invitations.filter((invitation) => invitation.status === "Pending").map(invitationOf);
  }

  async wasInvited(email: string): Promise<boolean> {
    const invitations = await this.call<LogtoInvitation[]>("GET", `/api/organization-invitations?invitee=${encodeURIComponent(email)}`);
    return invitations.some((invitation) => invitation.status === "Pending" || invitation.status === "Accepted");
  }

  /** Refuses an invitation of another organization. */
  async revokeInvitation(organizationId: string, invitationId: string): Promise<void> {
    await this.setStatus(organizationId, invitationId, { status: "Revoked" });
  }

  /** Logto itself adds the user to the organization, with the invitation's roles, when it turns `Accepted`. */
  async acceptInvitation(organizationId: string, invitationId: string, userId: string): Promise<void> {
    await this.setStatus(organizationId, invitationId, { status: "Accepted", acceptedUserId: userId });
  }

  /** Refuses an invitation of another organization. */
  private async setStatus(organizationId: string, invitationId: string, status: { status: string; acceptedUserId?: string }): Promise<void> {
    const path = `/api/organization-invitations/${encodeURIComponent(invitationId)}`;
    const invitation = await this.call<LogtoInvitation>("GET", path);
    if (invitation.organizationId !== organizationId) throw new Error(`Invitation ${invitationId} is not one of organization ${organizationId}`);
    await this.call("PUT", `${path}/status`, status);
  }

  async closeRegistration(): Promise<void> {
    await this.call("PATCH", "/api/sign-in-exp", { signInMode: "SignIn" });
  }

  private async adminRoleIdOf(): Promise<string> {
    if (this.adminRoleId !== null) return this.adminRoleId;
    const roles = await this.call<{ id: string; name: string }[]>("GET", `/api/organization-roles?q=${adminRole}`);
    const role = roles.find((candidate) => candidate.name === adminRole);
    if (!role) throw new Error(`Logto has no organization role "${adminRole}"; the setup command creates it`);
    this.adminRoleId = role.id;
    return role.id;
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.settings.endpoint}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Logto's Management API answered ${method} ${path} with ${response.status}: ${await response.text()}`);
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  private async accessToken(): Promise<string> {
    if (this.token !== null && this.token.expiresAt > this.now()) return this.token.value;
    const { clientId, clientSecret, endpoint } = this.settings;
    const response = await fetch(`${endpoint}/oidc/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", resource: this.resource, scope: "all" }).toString(),
    });
    if (!response.ok) throw new Error(`Logto refused the management client's credentials with ${response.status}: ${await response.text()}`);
    const token = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: token.access_token, expiresAt: this.now() + token.expires_in * 1000 - tokenMargin };
    return token.access_token;
  }
}
