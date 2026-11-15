import type { AdminAccess } from "./admin-access";
import type { IdentityProviderClient, PendingSignIn } from "./ports";

/** The one Identity Provider, as the operator configured it in the environment (ADR-0007). */
export type IdentityProviderSettings = {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  requiredGroup: string;
  /**
   * Whether only someone an Admin of the Family already has the verified email of may sign in:
   * then no Admin is made from a sign-in, not even the first. Off when not given.
   */
  knownAdminsOnly?: boolean;
  /** The address the Family reaches the Instance at, its path prefix included; the redirect URI lies below it. */
  publicBaseUrl: string;
};

export type SingleSignOnDeps = {
  /** Null when no Identity Provider is configured. */
  settings: IdentityProviderSettings | null;
  client: IdentityProviderClient;
  admins: AdminAccess;
};

/** Where the Identity Provider sends an Admin back to, below the public base URL and so below its path prefix. */
export const singleSignOnCallbackPath = "/sso/callback";

export const defaultRequiredGroup = "homelab-admin";

export type SingleSignOnSignInResult =
  | { ok: true; sessionToken: string }
  | {
      ok: false;
      problem: "sso-failed" | "sso-not-in-group" | "sso-email-unverified" | "sso-conflict" | "sso-unknown-admin";
    };

export function createSingleSignOn(deps: SingleSignOnDeps) {
  const { settings, client, admins } = deps;

  const at = (baseUrl: string): IdentityProviderSettings | null =>
    settings !== null && settings.publicBaseUrl === baseUrl ? settings : null;

  const connectionOf = (offered: IdentityProviderSettings) => ({
    issuerUrl: offered.issuerUrl,
    clientId: offered.clientId,
    clientSecret: offered.clientSecret,
  });

  return {
    /** Whether single sign-on is offered to someone who reached the Instance at `baseUrl`, path prefix included. */
    isOfferedAt(baseUrl: string): boolean {
      return at(baseUrl) !== null;
    },

    /** Whether a Family without Admins makes its first from a sign-in at `baseUrl`: not when only known Admins may sign in. */
    makesFirstAdminAt(baseUrl: string): boolean {
      const offered = at(baseUrl);
      return offered !== null && offered.knownAdminsOnly !== true;
    },

    /** Where to send an Admin to sign in, with what to remember until they return; null if it is not offered at `baseUrl`. */
    async begin(baseUrl: string): Promise<{ authorizationUrl: string; pending: PendingSignIn } | null> {
      const offered = at(baseUrl);
      if (!offered) return null;
      return client.begin(connectionOf(offered), offered.publicBaseUrl + singleSignOnCallbackPath);
    },

    /**
     * Signs in the Admin the provider sent back, if they belong to the required group; on an
     * Instance without Admins yet, they become its first. With `knownAdminsOnly`, only an Admin
     * who already exists signs in, and none is made.
     */
    async complete(input: { baseUrl: string; query: string; pending: PendingSignIn }): Promise<SingleSignOnSignInResult> {
      const offered = at(input.baseUrl);
      if (!offered) return { ok: false, problem: "sso-failed" };
      const redirectUri = offered.publicBaseUrl + singleSignOnCallbackPath;
      const identity = await client.complete(connectionOf(offered), redirectUri, redirectUri + input.query, input.pending);
      if (!identity) return { ok: false, problem: "sso-failed" };
      // Checked at every sign-in; leaving the group ends no running session.
      if (!identity.groups.includes(offered.requiredGroup)) return { ok: false, problem: "sso-not-in-group" };
      const result = await admins.signInThroughIdentityProvider(identity, { knownAdminsOnly: offered.knownAdminsOnly === true });
      if (result.ok) return result;
      return { ok: false, problem: identityProblems[result.problem] };
    },
  };
}

const identityProblems = {
  "identity-conflict": "sso-conflict",
  "identity-email-unverified": "sso-email-unverified",
  "identity-unknown-admin": "sso-unknown-admin",
} as const;

export type SingleSignOn = ReturnType<typeof createSingleSignOn>;

export type IdentityProviderVariables = {
  issuerUrl?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  requiredGroup?: string | undefined;
  /** `true` or `false`, as text from the environment or as a value from a Context; off when not given. */
  knownAdminsOnly?: string | boolean | undefined;
  publicBaseUrl?: string | null | undefined;
};

export type ParsedIdentityProviderSettings =
  | { ok: true; settings: IdentityProviderSettings | null }
  | {
      ok: false;
      problem:
        | "invalid-issuer-url"
        | "invalid-client-id"
        | "client-secret-missing"
        | "invalid-required-group"
        | "invalid-known-admins-only"
        | "invalid-public-url";
    };

const maximumTextLength = 200;

type SettingsProblem = Extract<ParsedIdentityProviderSettings, { ok: false }>["problem"];

/** Each setting, checked in turn: its value, or null with the problem it has. */
const settingCheckers: {
  [K in Exclude<keyof IdentityProviderSettings, "knownAdminsOnly">]: [SettingsProblem, (variables: IdentityProviderVariables) => string | null];
} = {
  issuerUrl: ["invalid-issuer-url", (v) => httpUrl(v.issuerUrl ?? "")],
  clientId: ["invalid-client-id", (v) => shortText(v.clientId ?? "")],
  clientSecret: ["client-secret-missing", (v) => (v.clientSecret ?? "").trim() || null],
  requiredGroup: ["invalid-required-group", (v) => shortText(v.requiredGroup ?? defaultRequiredGroup)],
  publicBaseUrl: ["invalid-public-url", (v) => httpUrl(v.publicBaseUrl ?? "")],
};

/** The Identity Provider the variables configure; none when the issuer is not set. */
export function parseIdentityProviderSettings(variables: IdentityProviderVariables): ParsedIdentityProviderSettings {
  if (!variables.issuerUrl?.trim()) return { ok: true, settings: null };
  const settings: Partial<IdentityProviderSettings> = {};
  type Checked = keyof typeof settingCheckers;
  for (const [key, [problem, check]] of Object.entries(settingCheckers) as [Checked, (typeof settingCheckers)[Checked]][]) {
    const value = check(variables);
    if (value === null) return { ok: false, problem };
    settings[key] = value;
  }
  const knownAdminsOnly = switchOf(variables.knownAdminsOnly);
  if (knownAdminsOnly === null) return { ok: false, problem: "invalid-known-admins-only" };
  // Given only when on, so that settings without the switch stay as they were.
  if (knownAdminsOnly) settings.knownAdminsOnly = true;
  return { ok: true, settings: settings as IdentityProviderSettings };
}

/** A switch: on for `true`, off for `false` or nothing; null for anything else. */
function switchOf(value: string | boolean | undefined): boolean | null {
  if (typeof value === "boolean") return value;
  const text = (value ?? "").trim();
  if (text === "true") return true;
  return text === "" || text === "false" ? false : null;
}

function shortText(text: string): string | null {
  const trimmed = text.trim();
  return isShortText(trimmed) ? trimmed : null;
}

function isShortText(text: string): boolean {
  return text !== "" && text.length <= maximumTextLength;
}

/** An http or https URL without credentials, query or fragment, with its path but without a trailing slash. */
function httpUrl(text: string): string | null {
  const url = parsedPlainUrl(text.trim());
  if (!url) return null;
  return url.href.replace(/\/+$/, ""); // eslint-disable-line sonarjs/super-linear-regex -- single-char quantifier anchored at end is O(n)
}

function parsedPlainUrl(text: string): URL | null {
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  const plain = (url.protocol === "http:" || url.protocol === "https:") && url.username + url.password + url.search + url.hash === "";
  return plain ? url : null;
}
