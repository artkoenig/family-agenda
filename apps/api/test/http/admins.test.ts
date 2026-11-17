import { afterEach, describe, expect, it } from "vitest";
import { bootHttpForTest, signedInCookie, type HttpTestInstance } from "../support/http";
import { InMemoryIdentityDirectory } from "../support/in-memory-identity-directory";

describe("the Admins page (ADR-0010)", () => {
  let instance: HttpTestInstance;
  let directory: InMemoryIdentityDirectory;
  let cookie: string;

  const boot = async (withDirectory = true) => {
    directory = new InMemoryIdentityDirectory();
    directory.users.set("user-anna", { email: "anna@example.org", lastSignInAt: new Date("2026-11-16T08:00:00Z") });
    directory.users.set("user-ben", { email: "ben@example.org", lastSignInAt: null });
    instance = await bootHttpForTest({}, withDirectory ? { idpWebhookSecret: "logto-signing-key", identityDirectoryClient: directory } : {});
    if (withDirectory) await instance.app.registration.register({ userId: "user-anna", email: "anna@example.org" });
    await instance.app.recoveryKit.confirm();
    cookie = await signedInCookie(instance, { subject: "user-anna", email: "anna@example.org" });
  };
  const organization = () => [...directory.organizations.values()][0];
  const get = async (path: string) => (await instance.get(path, { cookie })).text();
  const post = (path: string, form: Record<string, string> = {}) => instance.post(path, form, { cookie });

  afterEach(async () => {
    await instance.close();
  });

  it("is in the settings list only with a management API", async () => {
    await boot(false);
    expect(await get("/admin/family-members")).not.toContain('href="/admin/admins"');
    expect((await instance.get("/admin/admins", { cookie })).status).toBe(404);
    await instance.close();

    await boot();
    expect(await get("/admin/family-members")).toContain('href="/admin/admins"');
  });

  it("lists the Admins with their last sign-in, and the pending invitations", async () => {
    await boot();
    await instance.app.familyAdmins.invite("carla@example.org", "https://x/admin/sign-in");

    const page = await get("/admin/admins");

    expect(page).toContain("anna@example.org");
    expect(page).toContain("2026");
    expect(page).toContain("carla@example.org");
  });

  it("invites by email with a link to the Family's sign-in, and names a refused address", async () => {
    await boot();

    const invited = await post("/admin/admins/invitations", { email: "carla@example.org" });
    expect(invited.status).toBe(303);
    expect(invited.headers.get("location")).toBe("/admin/admins");
    expect([...(organization()?.invitations.values() ?? [])][0]).toMatchObject({ email: "carla@example.org", link: "http://localhost/admin/sign-in" });

    const refused = await post("/admin/admins/invitations", { email: "anna@example.org" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("already an Admin");
  });

  it("revokes an invitation", async () => {
    await boot();
    await instance.app.familyAdmins.invite("carla@example.org", "https://x/admin/sign-in");
    const [invitationId] = [...(organization()?.invitations.keys() ?? [])];

    expect((await post(`/admin/admins/invitations/${invitationId}/revoke`)).status).toBe(303);
    expect(organization()?.invitations.size).toBe(0);
  });

  it("removes an Admin, and refuses to remove the last one", async () => {
    await boot();
    await directory.addMember([...directory.organizations.keys()][0] ?? "", "user-ben");

    expect((await post("/admin/admins/user-ben/remove")).status).toBe(303);
    const refused = await post("/admin/admins/user-anna/remove");
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("last Admin");
    expect([...(organization()?.members.keys() ?? [])]).toEqual(["user-anna"]);
  });

  it("speaks German in a German Family", async () => {
    await boot();
    await instance.app.languages.setLanguage("de");

    const page = await get("/admin/admins");
    expect(page).toContain("Einladen");
  });
});
