import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OidcIdentityProviderClient } from "../src/oidc-identity-provider-client";
import { FakeIdentityProvider } from "./support/fake-identity-provider";

const redirectUri = "https://agenda.example.ts.net/sso/callback";

describe("the OIDC client", () => {
  let provider: FakeIdentityProvider;
  const client = new OidcIdentityProviderClient();
  const connection = () => ({
    issuerUrl: provider.issuer,
    clientId: "family-agenda",
    clientSecret: "s3cret",
  });
  beforeEach(async () => {
    provider = await FakeIdentityProvider.start();
  });
  afterEach(async () => {
    await provider.stop();
  });

  const signIn = async (
    callback: (back: string) => string = (back) => back,
  ) => {
    const { authorizationUrl, pending } = await client.begin(
      connection(),
      redirectUri,
    );
    const query = new URL(authorizationUrl).searchParams;
    const back = await provider.authorize(authorizationUrl);
    return {
      query,
      pending,
      result: client.complete(
        connection(),
        redirectUri,
        callback(back),
        pending,
      ),
    };
  };

  it("discovers a provider, and tells why it cannot", async () => {
    expect(await client.discover(provider.issuer)).toEqual({ ok: true });

    const failed = await client.discover("http://127.0.0.1:1");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.message).not.toBe("");
  });

  it("asks for the scopes openid email profile groups with a PKCE challenge", async () => {
    const { query } = await signIn();

    expect(query.get("scope")).toBe("openid email profile groups");
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("redirect_uri")).toBe(redirectUri);
    expect(query.get("client_id")).toBe("family-agenda");
  });

  it("returns who signed in, with email and groups", async () => {
    const { result } = await signIn();

    expect(await result).toEqual({
      subject: "sub-anna",
      email: "anna@example.org",
      emailVerified: true,
      groups: ["homelab-admin"],
    });
  });

  it("reads a token without email or groups as none", async () => {
    provider.claims = { sub: "sub-2", groups: "not-a-list" };

    const { result } = await signIn();

    expect(await result).toEqual({
      subject: "sub-2",
      email: null,
      emailVerified: false,
      groups: [],
    });
  });

  it("refuses a return with another state", async () => {
    const { result } = await signIn(
      () => `${redirectUri}?code=abc&state=forged`,
    );

    expect(await result).toBeNull();
  });

  it("refuses a token for another nonce, and an Admin the provider turns away", async () => {
    const returnFrom = async () => {
      const { authorizationUrl, pending } = await client.begin(connection(), redirectUri);
      return { pending, back: await provider.authorize(authorizationUrl) };
    };
    const forNonce = await returnFrom();
    const forSecret = await returnFrom();

    expect(
      await client.complete(connection(), redirectUri, forNonce.back, {
        ...forNonce.pending,
        nonce: "other",
      }),
    ).toBeNull();
    expect(
      await client.complete(
        { ...connection(), clientSecret: "wrong" },
        redirectUri,
        forSecret.back,
        forSecret.pending,
      ),
    ).toBeNull();
  });
});
