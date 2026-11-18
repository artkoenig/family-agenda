import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { organizationName } from "@family-agenda/application";
import { defaultLogtoManagementResource, LogtoIdentityDirectory } from "../src";
import { StubLogto } from "./support/stub-logto";

const familyId = "0b4f9c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const details = { expiresAt: new Date("2026-11-24T10:00:00Z"), link: "https://agenda.example.org/invitation", locale: "de" };

describe("the Logto Identity Directory", () => {
  let logto: StubLogto;
  let clock: number;
  let directory: LogtoIdentityDirectory;
  beforeEach(async () => {
    logto = await StubLogto.start();
    clock = 1_000_000;
    directory = new LogtoIdentityDirectory(
      { api: "logto", endpoint: logto.endpoint, clientId: "m2m-client", clientSecret: "m2m:secret" },
      { now: () => clock },
    );
  });
  afterEach(async () => {
    await logto.stop();
  });

  it("creates a Family's organization with the Family id in its customData", async () => {
    const organizationId = await directory.createOrganization(familyId, "The Müllers");
    expect(logto.organizations.get(organizationId)).toMatchObject({ name: "The Müllers", customData: { familyId } });
  });

  it("records the founder with the organization, next to the Family id, and reads it back (#469)", async () => {
    const organizationId = await directory.createOrganization(familyId, "The Müllers", "user-anna");
    expect(logto.organizations.get(organizationId)).toMatchObject({ customData: { familyId, founderUserId: "user-anna" } });
    expect(await directory.founderOf(organizationId)).toBe("user-anna");
    expect(await directory.founderOf(await directory.createOrganization(familyId, "B"))).toBeNull();
  });

  it("deletes a user, ending their memberships (#469)", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    logto.users.set("user-1", { primaryEmail: "ben@example.org", lastSignInAt: null });
    await directory.addMember(organizationId, "user-1");
    await directory.deleteUser("user-1");
    expect(logto.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/api/users/user-1" });
    expect(await directory.listMembers(organizationId)).toEqual([]);
    expect(await directory.organizationsOf("user-1")).toBeNull();
  });

  it("signs in with client credentials for the Management API, and reuses the token until shortly before it expires", async () => {
    await directory.createOrganization(familyId, "A");
    await directory.createOrganization(familyId, "B");
    expect(logto.tokenRequests).toHaveLength(1);
    const [request] = logto.tokenRequests;
    expect(request?.authorization).toBe(`Basic ${Buffer.from("m2m-client:m2m%3Asecret").toString("base64")}`);
    expect(Object.fromEntries(request?.form ?? [])).toEqual({ grant_type: "client_credentials", resource: defaultLogtoManagementResource, scope: "all" });
    expect(logto.requests.map((call) => call.authorization)).toEqual(["Bearer token-1", "Bearer token-1"]);

    clock += 3_540_000;
    await directory.createOrganization(familyId, "C");
    expect(logto.tokenRequests).toHaveLength(2);
    expect(logto.requests.at(-1)?.authorization).toBe("Bearer token-2");
  });

  it("asks for the resource it is given", async () => {
    const cloud = new LogtoIdentityDirectory({ api: "logto", endpoint: logto.endpoint, clientId: "c", clientSecret: "s" }, { resource: "https://tenant.logto.app/api" });
    await cloud.createOrganization(familyId, "A");
    expect(logto.tokenRequests[0]?.form.get("resource")).toBe("https://tenant.logto.app/api");
  });

  it("fails when Logto refuses the credentials", async () => {
    logto.refuseToken = true;
    await expect(directory.createOrganization(familyId, "A")).rejects.toThrow(/refused the management client's credentials with 401/);
  });

  it("fails naming the request Logto refused", async () => {
    logto.failNext = 500;
    await expect(directory.createOrganization(familyId, "A")).rejects.toThrow(/answered POST \/api\/organizations with 500/);
  });

  it("adds a member with the role admin, and lists the members with email and last sign-in", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    logto.users.set("user-1", { primaryEmail: "anna@example.org", lastSignInAt: Date.parse("2026-11-01T08:00:00Z") });
    logto.users.set("user-2", { primaryEmail: null, lastSignInAt: null });
    await directory.addMember(organizationId, "user-1");
    await directory.addMember(organizationId, "user-2");
    expect(logto.organizations.get(organizationId)?.members.get("user-1")).toEqual(["role-admin"]);
    expect(logto.requests.filter((call) => call.path.startsWith("/api/organization-roles"))).toHaveLength(1);
    expect(await directory.listMembers(organizationId)).toEqual([
      { userId: "user-1", email: "anna@example.org", lastSignInAt: new Date("2026-11-01T08:00:00Z") },
      { userId: "user-2", email: null, lastSignInAt: null },
    ]);
  });

  it("adds a member again without a second role, as a retried registration does", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    await directory.addMember(organizationId, "user-1");
    await directory.addMember(organizationId, "user-1");
    expect(logto.organizations.get(organizationId)?.members.get("user-1")).toEqual(["role-admin"]);
  });

  it("finds a Family's organization by the Family id in its name, and none for another", async () => {
    const other = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
    await directory.createOrganization(other, organizationName(other));
    const organizationId = await directory.createOrganization(familyId, organizationName(familyId));
    // A name holding the Family id as a part is not the Family's.
    await directory.createOrganization(other, `${organizationName(familyId)} (old)`);

    expect(await directory.findOrganization(familyId)).toBe(organizationId);
    expect(await directory.findOrganization("1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b")).toBeNull();
    expect(logto.requests.at(-1)?.path).toBe("/api/organizations?q=1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b&page_size=20");
  });

  it("deletes an organization", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    await directory.deleteOrganization(organizationId);
    expect(logto.organizations.has(organizationId)).toBe(false);
  });

  it("lists the organizations a user is a member of, and none for a user who does not exist", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    logto.users.set("user-1", { primaryEmail: "anna@example.org", lastSignInAt: null });
    logto.users.set("user-2", { primaryEmail: "ben@example.org", lastSignInAt: null });
    await directory.addMember(organizationId, "user-1");

    expect(await directory.organizationsOf("user-1")).toEqual([organizationId]);
    expect(await directory.organizationsOf("user-2")).toEqual([]);
    expect(await directory.organizationsOf("user-gone")).toBeNull();
  });

  it("lists members across pages", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    const members = logto.organizations.get(organizationId)?.members;
    for (let index = 0; index < 150; index++) members?.set(`user-${index}`, []);
    const listed = await directory.listMembers(organizationId);
    expect(listed).toHaveLength(150);
    expect(listed.at(-1)?.userId).toBe("user-149");
  });

  it("closes registration by setting the sign-in experience to sign-in only", async () => {
    await directory.closeRegistration();
    expect(logto.signInMode).toBe("SignIn");
    expect(logto.requests.at(-1)).toMatchObject({ method: "PATCH", path: "/api/sign-in-exp" });
  });

  it("removes a member", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    await directory.addMember(organizationId, "user-1");
    await directory.removeMember(organizationId, "user-1");
    expect(await directory.listMembers(organizationId)).toEqual([]);
  });

  it("fails when Logto has no organization role admin", async () => {
    logto.roles = [{ id: "role-other", name: "admin-like" }];
    const organizationId = await directory.createOrganization(familyId, "A");
    await expect(directory.addMember(organizationId, "user-1")).rejects.toThrow(/no organization role "admin"/);
  });

  it("creates a one-time token for the invitee, valid until the invitation expires, without a JIT organization (ADR-0011)", async () => {
    const token = await directory.createSignInToken("ben@example.org", new Date(clock + 7 * 24 * 3600 * 1000 + 1));
    expect(logto.oneTimeTokens.get(token)).toEqual({ email: "ben@example.org", expiresIn: 7 * 24 * 3600 + 1 });
    const late = await directory.createSignInToken("ben@example.org", new Date(clock - 5000));
    expect(logto.oneTimeTokens.get(late)).toEqual({ email: "ben@example.org", expiresIn: 1 });
  });

  it("invites by email as an admin, with the expiry and the link for the email, and lists the pending invitations", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    const invitation = await directory.invite(organizationId, "ben@example.org", details);
    expect(invitation).toMatchObject({ email: "ben@example.org", expiresAt: details.expiresAt });
    expect(logto.invitations.get(invitation.invitationId)).toMatchObject({
      organizationId,
      organizationRoleIds: ["role-admin"],
      messagePayload: { link: details.link, locale: "de" },
    });
    const other = await directory.createOrganization(familyId, "B");
    await directory.invite(other, "carl@example.org", details);
    expect(await directory.listInvitations(organizationId)).toEqual([invitation]);
  });

  it("revokes an invitation, which is then no longer pending", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    const invitation = await directory.invite(organizationId, "ben@example.org", details);
    await directory.revokeInvitation(organizationId, invitation.invitationId);
    expect(logto.invitations.get(invitation.invitationId)?.status).toBe("Revoked");
    expect(await directory.listInvitations(organizationId)).toEqual([]);
  });

  it("knows an email invited to any organization, pending or accepted, and not one revoked or never invited", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    await directory.invite(organizationId, "ben@example.org", details);
    const accepted = await directory.invite(organizationId, "carl@example.org", details);
    const revoked = await directory.invite(organizationId, "dora@example.org", details);
    const acceptedInvitation = logto.invitations.get(accepted.invitationId);
    const revokedInvitation = logto.invitations.get(revoked.invitationId);
    if (!acceptedInvitation || !revokedInvitation) throw new Error("no invitations");
    acceptedInvitation.status = "Accepted";
    revokedInvitation.status = "Revoked";
    expect(await directory.wasInvited("ben@example.org")).toBe(true);
    expect(await directory.wasInvited("carl@example.org")).toBe(true);
    expect(await directory.wasInvited("dora@example.org")).toBe(false);
    expect(await directory.wasInvited("eve@example.org")).toBe(false);
    expect(logto.requests.at(-1)?.path).toBe("/api/organization-invitations?invitee=eve%40example.org");
  });

  it("accepts an invitation: the user becomes a member with the role admin, and it is no longer pending", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    const invitation = await directory.invite(organizationId, "ben@example.org", details);
    await directory.acceptInvitation(organizationId, invitation.invitationId, "user-ben");
    expect(logto.requests.at(-1)).toMatchObject({ method: "PUT", path: `/api/organization-invitations/${invitation.invitationId}/status` });
    expect(logto.invitations.get(invitation.invitationId)?.status).toBe("Accepted");
    expect(logto.organizations.get(organizationId)?.members.get("user-ben")).toEqual(["role-admin"]);
    expect(await directory.listInvitations(organizationId)).toEqual([]);
  });

  it("refuses to accept another organization's invitation", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    const other = await directory.createOrganization(familyId, "B");
    const invitation = await directory.invite(other, "ben@example.org", details);
    await expect(directory.acceptInvitation(organizationId, invitation.invitationId, "user-ben")).rejects.toThrow(/is not one of organization/);
    expect(logto.invitations.get(invitation.invitationId)?.status).toBe("Pending");
  });

  it("refuses to revoke another organization's invitation", async () => {
    const organizationId = await directory.createOrganization(familyId, "A");
    const other = await directory.createOrganization(familyId, "B");
    const invitation = await directory.invite(other, "ben@example.org", details);
    await expect(directory.revokeInvitation(organizationId, invitation.invitationId)).rejects.toThrow(/is not one of organization/);
    expect(logto.invitations.get(invitation.invitationId)?.status).toBe("Pending");
  });
});
