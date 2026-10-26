import { afterEach, describe, expect, it } from "vitest";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";

const password = "correct horse battery";

describe("sign-in protection over HTTP", () => {
  let instance: HttpTestInstance;
  const boot = async (trustProxy: boolean) => {
    instance = await bootHttpForTest({ trustProxy });
    await instance.post("/setup", { email: "anna@example.org", password });
  };
  afterEach(async () => {
    await instance.close();
  });

  const signIn = (email: string, pw: string, headers: Record<string, string> = {}) =>
    instance.post("/admin/sign-in", { email, password: pw }, { headers });

  it("rate-limits sign-in per account", async () => {
    await boot(false);
    for (let i = 0; i < 5; i++) await signIn("anna@example.org", "wrong password!!");

    const response = await signIn("anna@example.org", password);

    expect(response.status).toBe(429);
    expect(await response.text()).toContain("Too many failed sign-ins");
  });

  it("rate-limits sign-in per client, telling clients apart through a trusted proxy", async () => {
    await boot(true);
    const fromGuesser = { "x-forwarded-for": "192.0.2.66" };
    for (let i = 0; i < 20; i++) await signIn(`guess${i}@example.org`, "wrong password!!", fromGuesser);

    expect((await signIn("anna@example.org", password, fromGuesser)).status).toBe(429);
    expect(
      (await signIn("anna@example.org", password, { "x-forwarded-for": "192.0.2.7" })).status,
    ).toBe(303);
  });

  it("sets a Secure cookie only behind HTTPS at a trusted proxy", async () => {
    await boot(true);
    const plain = await signIn("anna@example.org", password);
    const behindHttps = await signIn("anna@example.org", password, { "x-forwarded-proto": "https" });

    expect(plain.headers.get("set-cookie")).not.toMatch(/;\s*Secure/i);
    expect(behindHttps.headers.get("set-cookie")).toMatch(/;\s*Secure/i);
    expect(behindHttps.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });

  it("ignores forwarded headers without a trusted proxy", async () => {
    await boot(false);
    const response = await signIn("anna@example.org", password, { "x-forwarded-proto": "https" });

    expect(response.headers.get("set-cookie")).not.toMatch(/;\s*Secure/i);
  });
});
