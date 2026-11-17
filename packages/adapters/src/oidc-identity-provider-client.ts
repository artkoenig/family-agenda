import * as oidc from "openid-client";
import type {
  IdentityProviderClient,
  IdentityProviderConnection,
  PendingSignIn,
  SignInSecrets,
  SignOutRequest,
  VerifiedIdentity,
} from "@family-agenda/application";

/**
 * The scopes asked for: the standard ones, and the one named like the claim that decides, the first
 * segment of the Family claim's path (such as `custom_data`) if there is one, else the groups claim;
 * and the organizations' scope with a management API.
 */
const scopeOf = (connection: IdentityProviderConnection) =>
  [`openid email profile ${connection.familyIdClaim?.split(".")[0] ?? connection.groupsClaim}`, connection.organizations?.scope]
    .filter((scope) => scope !== undefined)
    .join(" ");

/** The strings in the list `value`; none if it is no list. */
const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);

/** The string at the dotted `path` of `claims`, such as `custom_data.familyId`; null if it is none. */
function stringAt(claims: Record<string, unknown>, path: string): string | null {
  let value: unknown = claims;
  for (const segment of path.split(".")) {
    value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[segment] : undefined;
  }
  return typeof value === "string" ? value : null;
}

/** An OIDC client with the authorization code flow and PKCE, through `openid-client`. */
export class OidcIdentityProviderClient implements IdentityProviderClient {
  async discover(
    issuerUrl: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await configurationOf({
        issuerUrl,
        clientId: "discovery",
        clientSecret: "",
        groupsClaim: "groups",
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async begin(
    connection: IdentityProviderConnection,
    redirectUri: string,
    stateOf?: (secrets: SignInSecrets) => string,
  ): Promise<{ authorizationUrl: string; pending: PendingSignIn }> {
    const configuration = await configurationOf(connection);
    const secrets: SignInSecrets = {
      nonce: oidc.randomNonce(),
      codeVerifier: oidc.randomPKCECodeVerifier(),
    };
    const pending: PendingSignIn = {
      state: stateOf ? stateOf(secrets) : oidc.randomState(),
      ...secrets,
    };
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      scope: scopeOf(connection),
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(
        pending.codeVerifier,
      ),
      code_challenge_method: "S256",
    });
    return { authorizationUrl: url.href, pending };
  }

  async complete(
    connection: IdentityProviderConnection,
    _redirectUri: string,
    callbackUrl: string,
    pending: PendingSignIn,
  ): Promise<VerifiedIdentity | null> {
    try {
      const configuration = await configurationOf(connection);
      const tokens = await oidc.authorizationCodeGrant(
        configuration,
        new URL(callbackUrl),
        {
          pkceCodeVerifier: pending.codeVerifier,
          expectedState: pending.state,
          expectedNonce: pending.nonce,
          idTokenExpected: true,
        },
      );
      const claims = tokens.claims();
      if (!claims) return null;
      return {
        subject: claims.sub,
        email: typeof claims.email === "string" ? claims.email : null,
        emailVerified: claims.email_verified === true,
        groups: stringsOf(claims[connection.groupsClaim]),
        familyId: connection.familyIdClaim === undefined ? null : stringAt(claims, connection.familyIdClaim),
        organizations: connection.organizations === undefined ? [] : stringsOf(claims[connection.organizations.claim]),
        ...(tokens.id_token === undefined ? {} : { idToken: tokens.id_token }),
      };
    } catch {
      return null;
    }
  }

  /** Null too when discovery fails: signing out of the Instance never waits on the provider. */
  async signOutUrl(connection: IdentityProviderConnection, request: SignOutRequest): Promise<string | null> {
    const configuration = await configurationOf(connection).catch(() => null);
    if (configuration === null) return null;
    if (configuration.serverMetadata().end_session_endpoint === undefined) return null;
    const parameters: Record<string, string> = {
      client_id: connection.clientId,
      post_logout_redirect_uri: request.postLogoutRedirectUri,
      id_token_hint: request.idToken,
    };
    if (request.state !== undefined) parameters.state = request.state;
    return oidc.buildEndSessionUrl(configuration, parameters).href;
  }
}

async function configurationOf(
  connection: IdentityProviderConnection,
): Promise<oidc.Configuration> {
  const issuer = new URL(connection.issuerUrl);
  return oidc.discovery(
    issuer,
    connection.clientId,
    connection.clientSecret,
    undefined,
    // A provider on the home network may speak plain HTTP.
    issuer.protocol === "http:"
      ? // eslint-disable-next-line sonarjs/deprecation, @typescript-eslint/no-deprecated
        { execute: [oidc.allowInsecureRequests] }
      : undefined,
  );
}
