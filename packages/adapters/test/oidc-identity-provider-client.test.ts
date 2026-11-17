import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OidcIdentityProviderClient } from "../src/oidc-identity-provider-client";
import { FakeIdentityProvider } from "./support/fake-identity-provider";

const redirectUri = "https://agenda.example.ts.net/sso/callback";

describe("the OIDC client", () => {
  let provider: FakeIdentityProvider;
  const client = new OidcIdentityProviderClient();
  let groupsClaim = "groups";
  let familyIdClaim: string | undefined;
  let organizations: { scope: string; claim: string } | undefined;
  const connection = () => ({
    issuerUrl: provider.issuer,
    clientId: "family-agenda",
    clientSecret: "s3cret",
    groupsClaim,
    ...(familyIdClaim === undefined ? {} : { familyIdClaim }),
    ...(organizations === undefined ? {} : { organizations }),
  });
  beforeEach(async () => {
    groupsClaim = "groups";
    familyIdClaim = undefined;
    organizations = undefined;
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
      familyId: null,
      organizations: [],
      idToken: expect.stringMatching(/^ey/) as unknown,
    });
  });

  it("reads the Family id at a nested claim path, and asks for its first segment as a scope", async () => {
    familyIdClaim = "custom_data.familyId";
    provider.claims = { sub: "sub-4", custom_data: { familyId: "f-1" }, family_id: "other" };

    const { query, result } = await signIn();

    expect(query.get("scope")).toBe("openid email profile custom_data");
    expect((await result)?.familyId).toBe("f-1");
  });

  it("reads a Family id that is missing, no string, or below no object as none", async () => {
    familyIdClaim = "custom_data.familyId";
    for (const claims of [{}, { custom_data: { familyId: 7 } }, { custom_data: "f-1" }, { custom_data: null }]) {
      provider.claims = { sub: "sub-5", ...claims };
      const { result } = await signIn();
      expect((await result)?.familyId).toBeNull();
    }
  });

  it("reads the organizations from their claim, and asks for their scope as well", async () => {
    organizations = { scope: "urn:logto:scope:organizations", claim: "organizations" };
    provider.claims = { sub: "sub-6", organizations: ["org-1", 7, "org-2"] };

    const { query, result } = await signIn();

    expect(query.get("scope")).toBe("openid email profile groups urn:logto:scope:organizations");
    expect((await result)?.organizations).toEqual(["org-1", "org-2"]);
  });

  it("reads organizations that are no list as none", async () => {
    organizations = { scope: "urn:logto:scope:organizations", claim: "organizations" };
    provider.claims = { sub: "sub-7", organizations: "org-1" };

    const { result } = await signIn();

    expect((await result)?.organizations).toEqual([]);
  });

  it("reads the groups from the configured claim, and asks for it as a scope", async () => {
    groupsClaim = "roles";
    provider.claims = { sub: "sub-3", roles: ["homelab-admin"], groups: ["other"] };

    const { query, result } = await signIn();

    expect(query.get("scope")).toBe("openid email profile roles");
    expect((await result)?.groups).toEqual(["homelab-admin"]);
  });

  it("reads a token without email or groups as none", async () => {
    provider.claims = { sub: "sub-2", groups: "not-a-list" };

    const { result } = await signIn();

    expect(await result).toEqual({
      subject: "sub-2",
      email: null,
      emailVerified: false,
      groups: [],
      familyId: null,
      organizations: [],
      idToken: expect.any(String) as unknown,
    });
  });

  it("makes the state from the sign-in's secrets when asked, and completes with it", async () => {
    const seen: { nonce: string; codeVerifier: string }[] = [];
    const { authorizationUrl, pending } = await client.begin(connection(), redirectUri, (secrets) => {
      seen.push(secrets);
      return `sealed.${secrets.nonce.length}`;
    });

    expect(seen).toEqual([{ nonce: pending.nonce, codeVerifier: pending.codeVerifier }]);
    expect(pending.state).toBe(`sealed.${pending.nonce.length}`);
    expect(new URL(authorizationUrl).searchParams.get("state")).toBe(pending.state);
    expect(authorizationUrl).not.toContain(pending.codeVerifier);
    const back = await provider.authorize(authorizationUrl);
    expect((await client.complete(connection(), redirectUri, back, pending))?.subject).toBe("sub-anna");
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

  describe("signing out at the provider", () => {
    const back = "https://agenda.example.ts.net/admin/sign-in";

    it("sends the browser to the end session endpoint with the ID token, the client and where to return", async () => {
      const url = new URL((await client.signOutUrl(connection(), { postLogoutRedirectUri: back, idToken: "ey.token", state: "s1" })) ?? "");

      expect(`${url.origin}${url.pathname}`).toBe(`${provider.issuer}/session/end`);
      expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "family-agenda", post_logout_redirect_uri: back, id_token_hint: "ey.token", state: "s1" });
    });

    it("leaves out the state when there is none", async () => {
      const url = new URL((await client.signOutUrl(connection(), { postLogoutRedirectUri: back, idToken: "ey.token" })) ?? "");

      expect(url.searchParams.has("state")).toBe(false);
    });

    it("gives none when the provider names no end session endpoint, or cannot be discovered", async () => {
      provider.endSession = false;
      expect(await client.signOutUrl(connection(), { postLogoutRedirectUri: back, idToken: "ey.token" })).toBeNull();
      expect(await client.signOutUrl({ ...connection(), issuerUrl: "http://127.0.0.1:1" }, { postLogoutRedirectUri: back, idToken: "ey.token" })).toBeNull();
    });
  });
});
