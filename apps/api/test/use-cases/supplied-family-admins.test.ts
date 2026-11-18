import { createFamilyAdmins } from "@family-agenda/application";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../support/fake-clock";
import { InMemoryIdentityDirectory } from "../support/in-memory-identity-directory";

const linkOf = () => "https://agenda.example.org/sso/start";

/** The Admins of a supplied Family (#469): the founder is never removed, and a removed Admin's user is deleted. */
describe("the Admins of a Family in supplied mode", () => {
  const boot = async (founder: string | undefined) => {
    const directory = new InMemoryIdentityDirectory();
    directory.users.set("user-anna", { email: "anna@example.org", lastSignInAt: null });
    directory.users.set("user-ben", { email: "ben@example.org", lastSignInAt: null });
    const organizationId = await directory.createOrganization("family-1", "Family Agenda family-1", founder);
    await directory.addMember(organizationId, "user-anna");
    await directory.addMember(organizationId, "user-ben");
    const admins = createFamilyAdmins({
      clock: new FakeClock(new Date("2026-11-18T08:00:00Z")),
      families: { organizationId: () => Promise.resolve(organizationId) },
      directory,
      familyLanguage: () => Promise.resolve("en"),
      deletesRemovedUsers: true,
    });
    return { directory, organizationId, admins };
  };

  it("refuses to remove the founder", async () => {
    const { directory, admins } = await boot("user-anna");

    expect(await admins.remove("user-anna")).toEqual({ ok: false, problem: "founder" });
    expect(await directory.organizationsOf("user-anna")).not.toBeNull();
  });

  it("deletes the user of a removed invited Admin, who then cannot sign in, and can be invited and become an Admin again", async () => {
    const { directory, organizationId, admins } = await boot("user-anna");

    expect(await admins.remove("user-ben")).toEqual({ ok: true });
    expect(await directory.organizationsOf("user-ben")).toBeNull();
    expect((await admins.list())?.admins.map((admin) => admin.userId)).toEqual(["user-anna"]);

    expect(await admins.invite("ben@example.org", linkOf)).toEqual({ ok: true });
    const [invitation] = (await admins.list())?.invitations ?? [];
    directory.users.set("user-ben-again", { email: "ben@example.org", lastSignInAt: null });
    await directory.acceptInvitation(organizationId, invitation?.invitationId ?? "", "user-ben-again");
    expect((await admins.list())?.admins.map((admin) => admin.userId)).toEqual(["user-anna", "user-ben-again"]);
  });

  it("refuses no one as founder in an organization created before founders were recorded, and still keeps the last Admin", async () => {
    const { directory, admins } = await boot(undefined);

    expect(await admins.remove("user-anna")).toEqual({ ok: true });
    expect(await directory.organizationsOf("user-anna")).toBeNull();
    expect(await admins.remove("user-ben")).toEqual({ ok: false, problem: "last-admin" });
  });
});
