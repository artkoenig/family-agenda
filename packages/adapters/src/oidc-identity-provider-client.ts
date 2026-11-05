import * as oidc from "openid-client";
import type {
  IdentityProviderClient,
  IdentityProviderConnection,
  PendingSignIn,
  VerifiedIdentity,
} from "@family-agenda/application";

const scope = "openid email profile groups";

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
  ): Promise<{ authorizationUrl: string; pending: PendingSignIn }> {
    const configuration = await configurationOf(connection);
    const pending: PendingSignIn = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      codeVerifier: oidc.randomPKCECodeVerifier(),
    };
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      scope,
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
        groups: Array.isArray(claims.groups)
          ? claims.groups.filter((group) => typeof group === "string")
          : [],
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
