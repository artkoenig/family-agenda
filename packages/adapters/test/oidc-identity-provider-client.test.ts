import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type CryptoKey,
} from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OidcIdentityProviderClient } from "../src/oidc-identity-provider-client";

const redirectUri = "https://agenda.example.ts.net/sso/callback";

/** A minimal OIDC provider: discovery, keys and a token endpoint that checks PKCE and the client secret. */
class FakeProvider {
  issuer = "";
  claims: Record<string, unknown> = {
    sub: "sub-1",
    email: "anna@example.org",
    email_verified: true,
    groups: ["homelab-admin"],
  };
  private server!: Server;
  private key!: CryptoKey;
  private jwk!: JWK;
  private challenge = "";
  private nonce = "";

  async start() {
    const pair = await generateKeyPair("RS256");
    this.key = pair.privateKey;
    this.jwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: "k1",
      alg: "RS256",
      use: "sig",
    };
    this.server = createServer(
      (request, response) => void this.handle(request, response),
    );
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    this.server.close();
  }

  /** What the authorization endpoint would remember from the Admin's browser trip. */
  authorize(authorizationUrl: string) {
    const query = new URL(authorizationUrl).searchParams;
    this.challenge = query.get("code_challenge") ?? "";
    this.nonce = query.get("nonce") ?? "";
    return query;
  }

  private async handle(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) {
    const url = new URL(request.url ?? "/", this.issuer);
    const json = (body: unknown) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
      });
      return;
    }
    if (url.pathname === "/jwks") {
      json({ keys: [this.jwk] });
      return;
    }
    if (url.pathname === "/token") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const form = new URLSearchParams(body);
      const verifierHash = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (
        verifierHash !== this.challenge ||
        form.get("client_secret") !== "s3cret"
      ) {
        response.statusCode = 400;
        json({ error: "invalid_grant" });
        return;
      }
      const idToken = await new SignJWT({ ...this.claims, nonce: this.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(this.issuer)
        .setAudience("family-agenda")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(this.key);
      json({ access_token: "access", token_type: "Bearer", id_token: idToken });
      return;
    }
    response.statusCode = 404;
    response.end();
  }
}

describe("the OIDC client", () => {
  let provider: FakeProvider;
  const client = new OidcIdentityProviderClient();
  const connection = () => ({
    issuerUrl: provider.issuer,
    clientId: "family-agenda",
    clientSecret: "s3cret",
  });
  beforeEach(async () => {
    provider = new FakeProvider();
    await provider.start();
  });
  afterEach(() => {
    provider.stop();
  });

  const signIn = async (
    callback: (query: URLSearchParams) => string = (query) =>
      `${redirectUri}?code=abc&state=${query.get("state")}`,
  ) => {
    const { authorizationUrl, pending } = await client.begin(
      connection(),
      redirectUri,
    );
    const query = provider.authorize(authorizationUrl);
    return {
      query,
      pending,
      result: client.complete(
        connection(),
        redirectUri,
        callback(query),
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
      subject: "sub-1",
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
    const { authorizationUrl, pending } = await client.begin(
      connection(),
      redirectUri,
    );
    provider.authorize(authorizationUrl);
    const callback = `${redirectUri}?code=abc&state=${pending.state}`;

    expect(
      await client.complete(connection(), redirectUri, callback, {
        ...pending,
        nonce: "other",
      }),
    ).toBeNull();
    expect(
      await client.complete(
        { ...connection(), clientSecret: "wrong" },
        redirectUri,
        callback,
        pending,
      ),
    ).toBeNull();
  });
});
