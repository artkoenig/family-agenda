import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminSummary } from "@family-agenda/application";
import { bootForTest, type TestInstance } from "../support/boot";

const password = "correct horse battery";

describe("managing Admins", () => {
  let instance: TestInstance;
  let anna: AdminSummary;
  beforeEach(async () => {
    instance = await bootForTest();
    const created = await instance.app.admins.createFirstAdmin({
      email: "anna@example.org",
      password,
    });
    if (!created.ok) throw new Error("setup failed");
    anna = (await instance.app.admins.authenticate(created.sessionToken))!;
  });
  afterEach(async () => {
    await instance.close();
  });

  const signIn = (email: string, pw: string) =>
    instance.app.admins.signIn({ email, password: pw, client: "192.0.2.1" });

  it("lets an Admin create an equal Admin, who can then sign in", async () => {
    const created = await instance.app.admins.createAdmin({
      email: "ben@example.org",
      password: "another long password",
    });
    expect(created).toEqual({ ok: true });

    const ben = await signIn("ben@example.org", "another long password");
    expect(ben.ok).toBe(true);
    if (!ben.ok) return;
    expect((await instance.app.admins.listAdmins()).map((admin) => admin.email)).toEqual(["anna@example.org", "ben@example.org"]);
  });

  it("refuses an Admin with an email that is already taken", async () => {
    expect(
      await instance.app.admins.createAdmin({ email: " ANNA@example.org", password }),
    ).toEqual({ ok: false, problem: "email-taken" });
  });

  it("lets an Admin reset another Admin's password, which ends that Admin's sessions", async () => {
    await instance.app.admins.createAdmin({ email: "ben@example.org", password });
    const benSession = await signIn("ben@example.org", password);
    if (!benSession.ok) throw new Error("sign-in failed");
    const ben = (await instance.app.admins.authenticate(benSession.sessionToken))!;

    expect(
      await instance.app.admins.resetPassword(anna, {
        adminId: ben.id,
        newPassword: "a brand new password",
      }),
    ).toEqual({ ok: true });

    expect(await instance.app.admins.authenticate(benSession.sessionToken)).toBeNull();
    expect((await signIn("ben@example.org", password)).ok).toBe(false);
    expect((await signIn("ben@example.org", "a brand new password")).ok).toBe(true);
  });

  it("does not reset an Admin's own password this way", async () => {
    expect(
      await instance.app.admins.resetPassword(anna, {
        adminId: anna.id,
        newPassword: "a brand new password",
      }),
    ).toEqual({ ok: false, problem: "own-account" });
  });

  it("issues a new password by email, as the CLI and the trigger do, which ends the Admin's sessions", async () => {
    const before = await signIn("anna@example.org", password);
    if (!before.ok) throw new Error("sign-in failed");

    const issued = await instance.app.admins.issueNewPassword({ email: "Anna@example.org" });

    expect(issued).toEqual({ ok: true, email: "anna@example.org", newPassword: expect.any(String) as unknown });
    if (!issued.ok) return;
    expect(await instance.app.admins.authenticate(before.sessionToken)).toBeNull();
    expect((await signIn("anna@example.org", password)).ok).toBe(false);
    expect((await signIn("anna@example.org", issued.newPassword)).ok).toBe(true);
    expect(await instance.app.admins.issueNewPassword({ email: "nobody@example.org" })).toEqual({ ok: false, problem: "unknown-admin" });
    expect(await instance.app.admins.issueNewPassword({ email: "not an email" })).toEqual({ ok: false, problem: "invalid-email" });
  });

  it("enters an Admin by email without a password, who cannot sign in with any password", async () => {
    expect(await instance.app.admins.enterAdmin({ email: " Ben@Example.org " })).toEqual({ ok: true, email: "ben@example.org", outcome: "added" });

    expect((await instance.app.admins.listAdmins()).map((admin) => admin.email)).toEqual(["anna@example.org", "ben@example.org"]);
    expect((await signIn("ben@example.org", "")).ok).toBe(false);
    expect((await signIn("ben@example.org", password)).ok).toBe(false);
  });

  it("changes nothing for an email an Admin already has, and says so", async () => {
    expect(await instance.app.admins.enterAdmin({ email: "ANNA@example.org" })).toEqual({ ok: true, email: "anna@example.org", outcome: "exists" });

    expect((await instance.app.admins.listAdmins()).length).toBe(1);
    expect((await signIn("anna@example.org", password)).ok).toBe(true);
  });

  it("refuses to enter an address that is no email", async () => {
    expect(await instance.app.admins.enterAdmin({ email: "not an email" })).toEqual({ ok: false, problem: "invalid-email" });
    expect((await instance.app.admins.listAdmins()).length).toBe(1);
  });
});

describe("entering the first Admin", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("makes the first Admin of a Family without Admins, which closes the setup", async () => {
    expect(await instance.app.admins.needsFirstAdmin()).toBe(true);

    expect(await instance.app.admins.enterAdmin({ email: "anna@example.org" })).toEqual({ ok: true, email: "anna@example.org", outcome: "first" });

    expect(await instance.app.admins.needsFirstAdmin()).toBe(false);
  });

  it("lets the entered Admin sign in through the Identity Provider with the same verified email", async () => {
    await instance.app.admins.enterAdmin({ email: "anna@example.org" });

    const signedIn = await instance.app.admins.signInThroughIdentityProvider({ subject: "sub-anna", email: "Anna@example.org", emailVerified: true });

    expect(signedIn.ok).toBe(true);
    expect((await instance.app.admins.listAdmins()).length).toBe(1);
  });
});
