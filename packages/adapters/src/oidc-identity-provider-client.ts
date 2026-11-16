import * as oidc from "openid-client";
import type {
  IdentityProviderClient,
  IdentityProviderConnection,
  PendingSignIn,
  SignInSecrets,
  VerifiedIdentity,
} from "@family-agenda/application";

/**
 * The scopes asked for: the standard ones, and the one named like the claim that decides, the first
 * segment of the Family claim's path (such as `custom_data`) if there is one, else the groups claim.
 */
const scopeOf = (connection: IdentityProviderConnection) =>
  `openid email profile ${connection.familyIdClaim?.split(".")[0] ?? connection.groupsClaim}`;

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
      const groups = claims[connection.groupsClaim];
      return {
        subject: claims.sub,
        email: typeof claims.email === "string" ? claims.email : null,
        emailVerified: claims.email_verified === true,
        groups: Array.isArray(groups)
          ? groups.filter((group) => typeof group === "string")
          : [],
        familyId: connection.familyIdClaim === undefined ? null : stringAt(claims, connection.familyIdClaim),
      };
    } catch {
      return null;
    }
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
