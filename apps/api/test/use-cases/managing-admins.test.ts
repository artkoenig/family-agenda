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

  it("resets any Admin's password by email, as the CLI does", async () => {
    expect(
      await instance.app.admins.resetPasswordByEmail({
        email: "Anna@example.org",
        newPassword: "a brand new password",
      }),
    ).toEqual({ ok: true });
    expect((await signIn("anna@example.org", "a brand new password")).ok).toBe(true);

    expect(
      await instance.app.admins.resetPasswordByEmail({
        email: "nobody@example.org",
        newPassword: "a brand new password",
      }),
    ).toEqual({ ok: false, problem: "unknown-admin" });
  });
});
