import { createHash, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";

/** The claims of an ID token: `sub`, `email`, `email_verified`, `groups`, `roles`, or nested ones such as `custom_data.familyId`. */
export type IdTokenClaims = Record<string, unknown> & { sub: string };

/** What the authorization endpoint remembers of a sign-in until its code is redeemed. */
type Grant = {
  claims: IdTokenClaims;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string | null;
};

const defaultClaims: IdTokenClaims = {
  sub: "sub-anna",
  email: "anna@example.org",
  email_verified: true,
  groups: ["homelab-admin"],
};

/**
 * An OIDC Identity Provider inside the test process, on a free port of 127.0.0.1: discovery, JWKS,
 * an authorization endpoint that signs in whoever `claims` describes, and a token endpoint that
 * checks the client secret, the redirect URI and PKCE before issuing a signed ID token.
 */
export class FakeIdentityProvider {
  /** The claims the next sign-in's ID token carries; set them per test. */
  claims: IdTokenClaims = { ...defaultClaims };
  private readonly grants = new Map<string, Grant>();
  private server: Server | null = null;
  private key!: CryptoKey;
  private jwk!: JWK;
  private address = "";

  constructor(
    readonly clientId = "family-agenda",
    readonly clientSecret = "s3cret",
  ) {}

  /** Starts a provider and waits until it listens. */
  static async start(clientId?: string, clientSecret?: string): Promise<FakeIdentityProvider> {
    const provider = new FakeIdentityProvider(clientId, clientSecret);
    const pair = await generateKeyPair("RS256");
    provider.key = pair.privateKey;
    provider.jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const server = createServer((request, response) => void provider.handle(request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    provider.server = server;
    provider.address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return provider;
  }

  /** The issuer URL, which discovery lies below. */
  get issuer(): string {
    return this.address;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
  }

  /** Follows an authorization URL as the browser would, and returns where the provider sends it back to. */
  async authorize(authorizationUrl: string): Promise<string> {
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    const location = response.headers.get("location");
    if (location === null) throw new Error(`The authorization endpoint answered ${response.status}: ${await response.text()}`);
    return location;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.issuer);
    const route = this.routes[url.pathname];
    if (route) await route(url, request, response);
    else answer(response, 404, { error: "not_found" });
  }

  private readonly routes: Record<
    string,
    (url: URL, request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  > = {
    "/.well-known/openid-configuration": (_url, _request, response) => {
      answer(response, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        code_challenge_methods_supported: ["S256"],
      });
    },
    "/jwks": (_url, _request, response) => {
      answer(response, 200, { keys: [this.jwk] });
    },
    "/authorize": (url, _request, response) => {
      this.authorizeRequest(url.searchParams, response);
    },
    "/token": async (_url, request, response) => {
      await this.redeem(request, response);
    },
  };

  private authorizeRequest(query: URLSearchParams, response: ServerResponse): void {
    const redirectUri = query.get("redirect_uri") ?? "";
    const valid =
      query.get("response_type") === "code" &&
      query.get("client_id") === this.clientId &&
      query.get("code_challenge_method") === "S256" &&
      URL.canParse(redirectUri);
    if (!valid) {
      answer(response, 400, { error: "invalid_request" });
      return;
    }
    const code = randomUUID();
    this.grants.set(code, {
      claims: structuredClone(this.claims),
      clientId: this.clientId,
      redirectUri,
      codeChallenge: query.get("code_challenge") ?? "",
      nonce: query.get("nonce"),
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    const state = query.get("state");
    if (state !== null) back.searchParams.set("state", state);
    response.writeHead(302, { location: back.href }).end();
  }

  private async redeem(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await bodyOf(request));
    const code = form.get("code") ?? "";
    const grant = this.grants.get(code);
    this.grants.delete(code);
    if (!grant || !this.redeems(grant, form, clientOf(request, form))) {
      answer(response, 400, { error: "invalid_grant" });
      return;
    }
    answer(response, 200, {
      access_token: randomUUID(),
      token_type: "Bearer",
      expires_in: 300,
      id_token: await this.idTokenOf(grant),
    });
  }

  private redeems(grant: Grant, form: URLSearchParams, client: { id: string; secret: string }): boolean {
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    return (
      client.id === grant.clientId &&
      client.secret === this.clientSecret &&
      form.get("redirect_uri") === grant.redirectUri &&
      challenge === grant.codeChallenge
    );
  }

  private idTokenOf(grant: Grant): Promise<string> {
    return new SignJWT({ ...grant.claims, ...(grant.nonce === null ? {} : { nonce: grant.nonce }) })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(this.issuer)
      .setAudience(grant.clientId)
      .setSubject(grant.claims.sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(this.key);
  }
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

/** The client a token request authenticates as, by HTTP Basic or by the form. */
function clientOf(request: IncomingMessage, form: URLSearchParams): { id: string; secret: string } {
  const basic = /^Basic (.+)$/i.exec(request.headers.authorization ?? "")?.[1];
  if (basic === undefined) return { id: form.get("client_id") ?? "", secret: form.get("client_secret") ?? "" };
  const [id = "", secret = ""] = Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent);
  return { id, secret };
}
