import { describe, expect, it } from "vitest";
import { InMemoryIdentityDirectory } from "./support/in-memory-identity-directory";

const details = { expiresAt: new Date("2026-11-24T10:00:00Z"), link: "https://agenda.example.org/invitation", locale: "en" };

describe("the in-memory Identity Directory", () => {
  it("keeps organizations with their Family id, members and pending invitations", async () => {
    const directory = new InMemoryIdentityDirectory();
    directory.users.set("user-1", { email: "anna@example.org", lastSignInAt: null });
    const organizationId = await directory.createOrganization("family-1", "The Müllers");
    expect(directory.organization(organizationId)).toMatchObject({ familyId: "family-1", name: "The Müllers" });

    await directory.addMember(organizationId, "user-1");
    await directory.addMember(organizationId, "user-2");
    expect(await directory.listMembers(organizationId)).toEqual([
      { userId: "user-1", email: "anna@example.org", lastSignInAt: null },
      { userId: "user-2", email: null, lastSignInAt: null },
    ]);
    await directory.removeMember(organizationId, "user-2");
    expect(await directory.listMembers(organizationId)).toHaveLength(1);

    const token = await directory.createSignInToken("ben@example.org", details.expiresAt);
    expect(directory.signInTokens.get(token)).toEqual({ email: "ben@example.org", expiresAt: details.expiresAt });
    const invitation = await directory.invite(organizationId, "ben@example.org", details);
    expect(await directory.listInvitations(organizationId)).toEqual([invitation]);
    expect([await directory.wasInvited("ben@example.org"), await directory.wasInvited("eve@example.org")]).toEqual([true, false]);
    const other = await directory.createOrganization("family-2", "Others");
    await expect(directory.revokeInvitation(other, invitation.invitationId)).rejects.toThrow(/is not one of/);
    await directory.revokeInvitation(organizationId, invitation.invitationId);
    expect(await directory.listInvitations(organizationId)).toEqual([]);
    expect(() => directory.organization("none")).toThrow(/No organization none/);
  });
});
