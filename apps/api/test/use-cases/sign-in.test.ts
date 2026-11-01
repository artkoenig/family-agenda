import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";

const password = "correct horse battery";
const minutes = 60 * 1000;

describe("Admin sign-in", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
    await instance.app.admins.createFirstAdmin({ email: "anna@example.org", password });
  });
  afterEach(async () => {
    await instance.close();
  });

  const signIn = (email: string, pw: string, client = "192.0.2.1") =>
    instance.app.admins.signIn({ email, password: pw, client });

  it("starts a session with the right email and password", async () => {
    const result = await signIn("ANNA@example.org", password);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await instance.app.admins.authenticate(result.sessionToken))?.email).toBe(
      "anna@example.org",
    );
  });

  it("refuses a wrong password or an unknown email alike", async () => {
    expect(await signIn("anna@example.org", "wrong password!!")).toEqual({
      ok: false,
      problem: "invalid-credentials",
    });
    expect(await signIn("nobody@example.org", password)).toEqual({
      ok: false,
      problem: "invalid-credentials",
    });
  });

  it("ends the session on sign-out", async () => {
    const result = await signIn("anna@example.org", password);
    if (!result.ok) throw new Error("sign-in failed");

    await instance.app.admins.signOut(result.sessionToken);

    expect(await instance.app.admins.authenticate(result.sessionToken)).toBeNull();
  });

  it("ends the session after 14 days", async () => {
    const result = await signIn("anna@example.org", password);
    if (!result.ok) throw new Error("sign-in failed");

    instance.clock.advance(14 * 24 * 60 * minutes);

    expect(await instance.app.admins.authenticate(result.sessionToken)).toBeNull();
  });

  it("forgets expired sessions no one used again when the next one starts", async () => {
    await signIn("anna@example.org", password);
    instance.clock.advance(14 * 24 * 60 * minutes);

    await signIn("anna@example.org", password);

    expect(await instance.query("SELECT expires_at FROM admin_session")).toEqual([
      { expires_at: new Date(instance.clock.now().getTime() + 14 * 24 * 60 * minutes) },
    ]);
  });

  it("locks an account after 5 failures from any clients, until 15 minutes have passed", async () => {
    for (let i = 0; i < 5; i++) await signIn("anna@example.org", "wrong password!!", `192.0.2.${i}`);

    expect(await signIn("anna@example.org", password, "192.0.2.99")).toEqual({
      ok: false,
      problem: "rate-limited",
    });

    instance.clock.advance(15 * minutes);
    expect((await signIn("anna@example.org", password, "192.0.2.99")).ok).toBe(true);
  });

  it("locks a client after 20 failures on any accounts, until 15 minutes have passed", async () => {
    for (let i = 0; i < 20; i++) await signIn(`guess${i}@example.org`, "wrong password!!");

    expect(await signIn("anna@example.org", password)).toEqual({
      ok: false,
      problem: "rate-limited",
    });
    expect((await signIn("anna@example.org", password, "192.0.2.2")).ok).toBe(true);

    instance.clock.advance(15 * minutes);
    expect((await signIn("anna@example.org", password)).ok).toBe(true);
  });

  it("checks at most 5 guesses for an account, even when they arrive at the same time", async () => {
    const burst = () =>
      Promise.all(Array.from({ length: 12 }, () => signIn("anna@example.org", "wrong password!!")));

    const results = [...(await burst()), ...(await burst()), ...(await burst())];

    const checked = results.filter((r) => !r.ok && r.problem === "invalid-credentials");
    expect(checked.length).toBeLessThanOrEqual(5);
  });

  it("forgets an account's failures after a successful sign-in", async () => {
    for (let i = 0; i < 4; i++) await signIn("anna@example.org", "wrong password!!");
    await signIn("anna@example.org", password);

    await signIn("anna@example.org", "wrong password!!");

    expect((await signIn("anna@example.org", password)).ok).toBe(true);
  });
});
