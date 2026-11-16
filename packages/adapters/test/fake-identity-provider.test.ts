import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeIdentityProvider } from "./support/fake-identity-provider";

const redirectUri = "https://agenda.example.ts.net/sso/callback";
const verifier = "a-code-verifier-long-enough-for-the-test-0123456789";
const challenge = "ZQl6fxGsI5xjSTJpBOq3VXAFklFXX2C0Xk90NrzOan4";

describe("the fake Identity Provider", () => {
  let provider: FakeIdentityProvider;
  beforeEach(async () => {
    provider = await FakeIdentityProvider.start();
  });
  afterEach(async () => {
    await provider.stop();
  });

  const authorizationUrl = (overrides: Record<string, string> = {}) =>
    `${provider.issuer}/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: "family-agenda",
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st",
      ...overrides,
    }).toString()}`;
  const codeOf = async (url = authorizationUrl()) =>
    new URL(await provider.authorize(url)).searchParams.get("code") ?? "";
  const redeem = (form: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${provider.issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: verifier, ...form }),
    });

  it("publishes discovery and the key that signs its ID tokens", async () => {
    const discovery = (await (await fetch(`${provider.issuer}/.well-known/openid-configuration`)).json()) as { issuer: string; jwks_uri: string };
    const jwks = (await (await fetch(discovery.jwks_uri)).json()) as { keys: { kid: string }[] };

    expect(discovery.issuer).toBe(provider.issuer);
    expect(jwks.keys.map((key) => key.kid)).toEqual(["k1"]);
    expect((await fetch(`${provider.issuer}/elsewhere`)).status).toBe(404);
  });

  it("sends the browser back with a code and the state", async () => {
    const back = new URL(await provider.authorize(authorizationUrl()));

    expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
    expect(back.searchParams.get("state")).toBe("st");
    expect(new URL(await provider.authorize(authorizationUrl({ state: "" }))).searchParams.get("state")).toBe("");
  });

  it("refuses an authorization request it cannot serve", async () => {
    for (const overrides of [{ response_type: "token" }, { client_id: "other" }, { code_challenge_method: "plain" }, { redirect_uri: "not a url" }])
      await expect(provider.authorize(authorizationUrl(overrides))).rejects.toThrow(/answered 400/);
  });

  it("issues an ID token with the claims a test chose, nested ones included, once per code", async () => {
    provider.claims = { sub: "sub-ben", email: "ben@example.org", email_verified: true, roles: ["admin"], custom_data: { familyId: "f-1" } };
    const code = await codeOf(authorizationUrl({ nonce: "n-1" }));

    const first = await redeem({ code, client_id: "family-agenda", client_secret: "s3cret" });
    const again = await redeem({ code, client_id: "family-agenda", client_secret: "s3cret" });

    const claims = decodeJwt(((await first.json()) as { id_token: string }).id_token);
    expect(claims).toMatchObject({ sub: "sub-ben", roles: ["admin"], custom_data: { familyId: "f-1" }, nonce: "n-1", iss: provider.issuer, aud: "family-agenda" });
    expect(again.status).toBe(400);
  });

  it("authenticates the client by HTTP Basic too, and leaves out a nonce it was not given", async () => {
    const basic = `Basic ${Buffer.from("family-agenda:s3cret").toString("base64")}`;

    const response = await redeem({ code: await codeOf() }, { authorization: basic });

    expect(decodeJwt(((await response.json()) as { id_token: string }).id_token)).not.toHaveProperty("nonce");
  });

  it("refuses a code for another client, secret, redirect URI or verifier", async () => {
    const client = { client_id: "family-agenda", client_secret: "s3cret" };
    for (const wrong of [{ client_id: "other" }, { client_secret: "wrong" }, { redirect_uri: "https://elsewhere.example/cb" }, { code_verifier: "other" }])
      expect((await redeem({ code: await codeOf(), ...client, ...wrong })).status).toBe(400);
    expect((await redeem({ code: "unknown", ...client })).status).toBe(400);
  });
});
