import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";
import { FakeIdentityProvider } from "../../../../packages/adapters/test/support/fake-identity-provider";

const identityProviderOf = (provider: FakeIdentityProvider) => ({
  issuerUrl: provider.issuer,
  clientId: "family-agenda",
  clientSecret: "s3cret",
  requiredGroup: "homelab-admin",
  groupsClaim: "groups",
  publicBaseUrl: "http://localhost",
});

describe("the link to the Identity Provider's sign-up (ADR-0010)", () => {
  let instance: HttpTestInstance | undefined;
  let provider: FakeIdentityProvider;
  beforeEach(async () => {
    provider = await FakeIdentityProvider.start();
  });
  afterEach(async () => {
    await instance?.close();
    await provider.stop();
  });

  it("is offered on the sign-in page when registration events are received, and opens the sign-up screen", async () => {
    instance = await bootHttpForTest({}, { identityProvider: identityProviderOf(provider), idpWebhookSecret: "logto-signing-key" });

    const page = await (await instance.get("/admin/sign-in")).text();
    const start = await instance.get("/sso/start?screen=register");

    expect(page).toContain('href="/sso/start?screen=register"');
    expect(new URL(start.headers.get("location") ?? "http://x").searchParams.get("first_screen")).toBe("register");
  });

  it("is not offered without registration, and a plain sign-in opens no sign-up screen", async () => {
    instance = await bootHttpForTest({}, { identityProvider: identityProviderOf(provider) });

    const page = await (await instance.get("/admin/sign-in")).text();
    const start = await instance.get("/sso/start?screen=register");

    expect(page).not.toContain("screen=register");
    expect(new URL(start.headers.get("location") ?? "http://x").searchParams.has("first_screen")).toBe(false);
  });
});
