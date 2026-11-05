import type { AdminAccess } from "./admin-access";
import type {
  Clock,
  IdentityProviderClient,
  IdentityProviderConnection,
  IdentityProviderRepository,
  PendingSignIn,
  SecretRef,
  SecretStore,
  StoredIdentityProvider,
} from "./ports";

export type SingleSignOnDeps = {
  clock: Clock;
  provider: IdentityProviderRepository;
  secrets: SecretStore;
  client: IdentityProviderClient;
  admins: AdminAccess;
};

/** Where the Identity Provider sends an Admin back to, below the public base URL. */
export const singleSignOnCallbackPath = "/sso/callback";

export const defaultRequiredGroup = "homelab-admin";

export type SingleSignOnSummary = {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  /** Whether a client secret is stored; it never leaves the SecretStore but to the provider. */
  hasClientSecret: boolean;
  requiredGroup: string;
  publicBaseUrl: string;
  /** What the Identity Provider's client must list as its redirect URI. */
  redirectUri: string;
};

export type SingleSignOnInput = {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  /** Left empty, the stored secret stays. */
  clientSecret: string;
  requiredGroup: string;
  publicBaseUrl: string;
};

export type SaveSingleSignOnResult =
  | { ok: true }
  | {
      ok: false;
      problem:
        | "invalid-issuer-url"
        | "invalid-client-id"
        | "invalid-required-group"
        | "invalid-public-url"
        | "client-secret-missing";
    }
  | { ok: false; problem: "discovery-failed"; message: string };

export type SingleSignOnSignInResult =
  | { ok: true; sessionToken: string }
  | {
      ok: false;
      problem:
        | "sso-failed"
        | "sso-not-in-group"
        | "sso-email-unverified"
        | "sso-conflict";
    };

const maximumTextLength = 200;

export function createSingleSignOn(deps: SingleSignOnDeps) {
  const { clock, provider, secrets, client, admins } = deps;

  /** The provider as the Admin configured it, if single sign-on is on for the origin the request came to. */
  async function persist(
    settings: { enabled: boolean; issuerUrl: string; clientId: string; requiredGroup: string; publicBaseUrl: string },
    newSecret: string,
    stored: StoredIdentityProvider | null,
  ): Promise<void> {
    const clientSecret = newSecret === "" ? (stored?.clientSecret ?? null) : await secrets.put(newSecret);
    await provider.save({ ...settings, clientSecret, savedAt: clock.now() });
    await removeReplaced(stored?.clientSecret ?? null, clientSecret);
  }

  async function removeReplaced(old: SecretRef | null, current: SecretRef | null): Promise<void> {
    if (old !== null && old !== current) await secrets.remove(old);
  }

  /** Why single sign-on cannot be switched on with these settings, if it cannot. */
  async function refusalToEnable(
    enabling: boolean,
    issuerUrl: string,
    hasSecret: boolean,
  ): Promise<SaveSingleSignOnResult | null> {
    if (!enabling) return null;
    if (!hasSecret) return { ok: false, problem: "client-secret-missing" };
    const discovery = await client.discover(issuerUrl);
    if (discovery.ok) return null;
    return { ok: false, problem: "discovery-failed", message: discovery.message };
  }

  async function enabledAt(
    origin: string,
  ): Promise<{
    stored: StoredIdentityProvider;
    connection: IdentityProviderConnection;
  } | null> {
    const stored = await provider.find();
    if (
      !stored?.enabled ||
      stored.publicBaseUrl !== origin ||
      !stored.clientSecret
    )
      return null;
    const clientSecret = await secrets.get(stored.clientSecret);
    if (clientSecret === null) return null;
    return {
      stored,
      connection: {
        issuerUrl: stored.issuerUrl,
        clientId: stored.clientId,
        clientSecret,
      },
    };
  }

  return {
    async current(): Promise<SingleSignOnSummary | null> {
      const stored = await provider.find();
      if (!stored) return null;
      return {
        enabled: stored.enabled,
        issuerUrl: stored.issuerUrl,
        clientId: stored.clientId,
        hasClientSecret: stored.clientSecret !== null,
        requiredGroup: stored.requiredGroup,
        publicBaseUrl: stored.publicBaseUrl,
        redirectUri: stored.publicBaseUrl + singleSignOnCallbackPath,
      };
    },

    /** Whether the sign-in page offers single sign-on to someone who reached the Instance at `origin`. */
    async isOfferedAt(origin: string): Promise<boolean> {
      return (await enabledAt(origin)) !== null;
    },

    /** Saved only once the provider's discovery document can be fetched. */
    async save(input: SingleSignOnInput): Promise<SaveSingleSignOnResult> {
      const checked = checkedSettings(input);
      if ("problem" in checked) return { ok: false, problem: checked.problem };
      const { issuerUrl } = checked;

      const stored = await provider.find();
      const newSecret = input.clientSecret.trim();
      const refusal = await refusalToEnable(input.enabled, issuerUrl, newSecret !== "" || Boolean(stored?.clientSecret));
      if (refusal) return refusal;

      await persist({ enabled: input.enabled, ...checked }, newSecret, stored);
      return { ok: true };
    },

    /** Where to send an Admin to sign in, with what to remember until they return; null if it is not offered at `origin`. */
    async begin(
      origin: string,
    ): Promise<{ authorizationUrl: string; pending: PendingSignIn } | null> {
      const enabled = await enabledAt(origin);
      if (!enabled) return null;
      return client.begin(
        enabled.connection,
        enabled.stored.publicBaseUrl + singleSignOnCallbackPath,
      );
    },

    /** Signs in the Admin the provider sent back, if they belong to the required group. */
    async complete(input: {
      origin: string;
      query: string;
      pending: PendingSignIn;
    }): Promise<SingleSignOnSignInResult> {
      const enabled = await enabledAt(input.origin);
      if (!enabled) return { ok: false, problem: "sso-failed" };
      const redirectUri =
        enabled.stored.publicBaseUrl + singleSignOnCallbackPath;
      const identity = await client.complete(
        enabled.connection,
        redirectUri,
        redirectUri + input.query,
        input.pending,
      );
      if (!identity) return { ok: false, problem: "sso-failed" };
      // Checked at every sign-in; leaving the group ends no running session.
      if (!identity.groups.includes(enabled.stored.requiredGroup))
        return { ok: false, problem: "sso-not-in-group" };
      const result = await admins.signInThroughIdentityProvider(identity);
      if (result.ok) return result;
      return {
        ok: false,
        problem:
          result.problem === "identity-conflict"
            ? "sso-conflict"
            : "sso-email-unverified",
      };
    },
  };
}

export type SingleSignOn = ReturnType<typeof createSingleSignOn>;

function checkedSettings(
  input: SingleSignOnInput,
):
  | {
      issuerUrl: string;
      clientId: string;
      requiredGroup: string;
      publicBaseUrl: string;
    }
  | {
      problem:
        | "invalid-issuer-url"
        | "invalid-client-id"
        | "invalid-required-group"
        | "invalid-public-url";
    } {
  const issuerUrl = httpUrl(input.issuerUrl, { keepPath: true });
  if (!issuerUrl) return { problem: "invalid-issuer-url" };
  const clientId = input.clientId.trim();
  if (!isShortText(clientId)) return { problem: "invalid-client-id" };
  const requiredGroup = input.requiredGroup.trim();
  if (!isShortText(requiredGroup)) return { problem: "invalid-required-group" };
  const publicBaseUrl = httpUrl(input.publicBaseUrl, { keepPath: false });
  if (!publicBaseUrl) return { problem: "invalid-public-url" };
  return { issuerUrl, clientId, requiredGroup, publicBaseUrl };
}

function isShortText(text: string): boolean {
  return text !== "" && text.length <= maximumTextLength;
}

/** An http or https URL without credentials, query or fragment; its origin, or with its path unless it is the root. */
function httpUrl(text: string, options: { keepPath: boolean }): string | null {
  const url = parsedPlainUrl(text.trim());
  if (!url) return null;
  if (!options.keepPath) return url.pathname === "/" ? url.origin : null;
  return url.href.replace(/\/+$/, ""); // eslint-disable-line sonarjs/super-linear-regex -- single-char quantifier anchored at end is O(n)
}

function parsedPlainUrl(text: string): URL | null {
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  const plain = (url.protocol === "http:" || url.protocol === "https:") && url.username + url.password + url.search + url.hash === "";
  return plain ? url : null;
}
