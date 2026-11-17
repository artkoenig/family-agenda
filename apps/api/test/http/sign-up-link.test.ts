import type { Registration } from "@family-agenda/application";
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

/** A registration that is open or closed as given. */
const registrationThatIs = (open: boolean): Registration => ({
  register: () => Promise.resolve(),
  isOpen: () => Promise.resolve(open),
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

  const boot = async (open: boolean) => {
    instance = await bootHttpForTest(
      {},
      { identityProvider: identityProviderOf(provider), idpWebhookSecret: "logto-signing-key", registration: registrationThatIs(open) },
    );
    return instance;
  };

  it("is offered on the sign-in page while registration is open, and opens the sign-up screen", async () => {
    const open = await boot(true);

    const page = await (await open.get("/admin/sign-in")).text();
    const start = await open.get("/sso/start?screen=register");

    expect(page).toContain('href="/sso/start?screen=register"');
    expect(new URL(start.headers.get("location") ?? "http://x").searchParams.get("first_screen")).toBe("register");
  });

  it("is not offered once registration is closed, even with the webhook secret set, and opens no sign-up screen", async () => {
    const closed = await boot(false);

    const page = await (await closed.get("/admin/sign-in")).text();
    const start = await closed.get("/sso/start?screen=register");

    expect(page).not.toContain("screen=register");
    expect(new URL(start.headers.get("location") ?? "http://x").searchParams.has("first_screen")).toBe(false);
  });
});
