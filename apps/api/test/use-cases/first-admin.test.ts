import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";

describe("first Admin", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("is needed on an Instance without Admins, and signs in once created", async () => {
    const { admins } = instance.app;
    expect(await admins.needsFirstAdmin()).toBe(true);

    const created = await admins.createFirstAdmin({
      email: "Anna@Example.org ",
      password: "correct horse battery",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const signedIn = await admins.authenticate(created.sessionToken);
    expect(signedIn?.email).toBe("anna@example.org");
    expect(await admins.needsFirstAdmin()).toBe(false);
  });

  it("cannot be created once an Admin exists", async () => {
    const { admins } = instance.app;
    await admins.createFirstAdmin({ email: "anna@example.org", password: "correct horse battery" });

    const second = await admins.createFirstAdmin({
      email: "mallory@example.org",
      password: "correct horse battery",
    });

    expect(second).toEqual({ ok: false, problem: "admin-exists" });
  });

  it("needs a valid email and a password of at least 12 characters", async () => {
    const { admins } = instance.app;

    expect(await admins.createFirstAdmin({ email: "anna", password: "correct horse battery" }))
      .toEqual({ ok: false, problem: "invalid-email" });
    expect(await admins.createFirstAdmin({ email: "anna@example.org", password: "short pass" }))
      .toEqual({ ok: false, problem: "password-too-short" });
    expect(await admins.needsFirstAdmin()).toBe(true);
  });
});
