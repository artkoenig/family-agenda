import { afterEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryIdentityDirectory } from "../support/in-memory-identity-directory";

const linkOf = ({ email, oneTimeToken }: { email: string; oneTimeToken: string }) => `https://agenda.example.org/sso/start?t=${oneTimeToken}&e=${email}`;

describe("the Admins of a Family with a management API (ADR-0010)", () => {
  let instance: TestInstance;
  let directory: InMemoryIdentityDirectory;
  const admins = () => instance.app.familyAdmins;

  const boot = async (options: { withDirectory?: boolean; registered?: boolean } = {}) => {
    directory = new InMemoryIdentityDirectory();
    directory.users.set("user-anna", { email: "anna@example.org", lastSignInAt: new Date("2026-11-16T08:00:00Z") });
    directory.users.set("user-ben", { email: "ben@example.org", lastSignInAt: null });
    instance = await bootForTest({
      idpWebhookSecret: "logto-signing-key",
      ...(options.withDirectory === false ? {} : { identityDirectoryClient: directory }),
    });
    if (options.registered !== false) await instance.app.registration.register({ userId: "user-anna", email: "anna@example.org" });
  };
  const organization = () => [...directory.organizations.values()][0];

  afterEach(async () => {
    await instance.close();
  });

  it("are offered only once the Family's organization exists, and never without a management API", async () => {
    await boot({ registered: false });
    expect(await admins().isOffered()).toBe(false);
    await instance.app.registration.register({ userId: "user-anna", email: "anna@example.org" });
    expect(await admins().isOffered()).toBe(true);
    await instance.close();

    await boot({ withDirectory: false });
    expect(await admins().isOffered()).toBe(false);
    expect(await admins().list()).toBeNull();
  });

  it("lists the Admins with their last sign-in, and the pending invitations", async () => {
    await boot();
    await admins().invite(" Carla@Example.org ", linkOf);

    expect(await admins().list()).toEqual({
      admins: [{ userId: "user-anna", email: "anna@example.org", lastSignInAt: new Date("2026-11-16T08:00:00Z") }],
      invitations: [expect.objectContaining({ email: "carla@example.org" }) as unknown],
    });
  });

  it("invites by email, valid for 7 days, in the Family Language, with a link carrying a one-time token for the invitee (ADR-0011)", async () => {
    await boot();
    await instance.app.languages.setLanguage("de");

    expect(await admins().invite("carla@example.org", linkOf)).toEqual({ ok: true });

    const [invitation] = [...(organization()?.invitations.values() ?? [])];
    const [[token, signIn]] = [...directory.signInTokens.entries()] as [[string, { email: string; expiresAt: Date }]];
    expect(invitation).toMatchObject({ email: "carla@example.org", link: linkOf({ email: "carla@example.org", oneTimeToken: token }), locale: "de" });
    expect(invitation?.expiresAt.getTime()).toBe(instance.clock.now().getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(signIn).toEqual({ email: "carla@example.org", expiresAt: invitation?.expiresAt });
  });

  it("refuses an address that is none, one of an Admin, or one invited already", async () => {
    await boot();
    await admins().invite("carla@example.org", linkOf);

    expect(await admins().invite("carla", linkOf)).toEqual({ ok: false, problem: "invalid-email" });
    expect(await admins().invite("ANNA@example.org", linkOf)).toEqual({ ok: false, problem: "already-admin" });
    expect(await admins().invite("carla@example.org", linkOf)).toEqual({ ok: false, problem: "already-invited" });
    expect(organization()?.invitations.size).toBe(1);
  });

  it("revokes an invitation", async () => {
    await boot();
    await admins().invite("carla@example.org", linkOf);
    const [invitation] = (await admins().list())?.invitations ?? [];

    await admins().revoke(invitation?.invitationId ?? "");

    expect((await admins().list())?.invitations).toEqual([]);
  });

  it("removes an Admin, but never the last one", async () => {
    await boot();
    await directory.addMember([...directory.organizations.keys()][0] ?? "", "user-ben");

    expect(await admins().remove("user-ben")).toEqual({ ok: true });
    expect(await admins().remove("user-anna")).toEqual({ ok: false, problem: "last-admin" });
    expect((await admins().list())?.admins.map((admin) => admin.userId)).toEqual(["user-anna"]);
  });

  it("keeps the removed Admin's user and records no founder in fixed mode", async () => {
    await boot();
    const organizationId = [...directory.organizations.keys()][0] ?? "";
    await directory.addMember(organizationId, "user-ben");

    expect(await directory.founderOf(organizationId)).toBeNull();
    expect(await admins().remove("user-anna")).toEqual({ ok: true });
    expect(await directory.organizationsOf("user-anna")).toEqual([]);
  });
});
