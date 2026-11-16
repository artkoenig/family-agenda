import { randomUUID } from "node:crypto";
import type {
  IdentityProviderClient,
  IdentityProviderConnection,
  PendingSignIn,
  SignInSecrets,
  VerifiedIdentity,
} from "@family-agenda/application";

/** An Identity Provider that answers as scripted, for use cases that do not care about OIDC itself. */
export class ScriptedIdentityProviderClient implements IdentityProviderClient {
  /** What discovery answers; set to a message to make it fail. */
  discoveryFailure: string | null = null;
  /** The connections it was asked to begin a sign-in for. */
  readonly begun: {
    connection: IdentityProviderConnection;
    redirectUri: string;
  }[] = [];
  private readonly identities = new Map<string, VerifiedIdentity>();

  discover(): Promise<{ ok: true } | { ok: false; message: string }> {
    return Promise.resolve(
      this.discoveryFailure === null
        ? { ok: true }
        : { ok: false, message: this.discoveryFailure },
    );
  }

  begin(connection: IdentityProviderConnection, redirectUri: string, stateOf?: (secrets: SignInSecrets) => string) {
    this.begun.push({ connection, redirectUri });
    const secrets: SignInSecrets = { nonce: randomUUID(), codeVerifier: randomUUID() };
    const pending: PendingSignIn = { state: stateOf ? stateOf(secrets) : randomUUID(), ...secrets };
    const authorizationUrl = `${connection.issuerUrl}/authorize?state=${encodeURIComponent(pending.state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    return Promise.resolve({ authorizationUrl, pending });
  }

  /** The query the provider sends the Admin back with after they signed in as `identity`. */
  returnWith(pending: PendingSignIn, identity: VerifiedIdentity): string {
    const code = randomUUID();
    this.identities.set(`${code}:${pending.state}`, identity);
    return `?code=${code}&state=${encodeURIComponent(pending.state)}`;
  }

  complete(
    _connection: IdentityProviderConnection,
    _redirectUri: string,
    callbackUrl: string,
    pending: PendingSignIn,
  ): Promise<VerifiedIdentity | null> {
    const query = new URL(callbackUrl).searchParams;
    return Promise.resolve(
      this.identities.get(`${query.get("code")}:${query.get("state")}`) ?? null,
    ).then((identity) =>
      query.get("state") === pending.state ? identity : null,
    );
  }
}
