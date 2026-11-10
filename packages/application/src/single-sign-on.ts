import type { AdminAccess } from "./admin-access";
import type { IdentityProviderClient, PendingSignIn } from "./ports";

/** The one Identity Provider, as the operator configured it in the environment (ADR-0007). */
export type IdentityProviderSettings = {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  requiredGroup: string;
  /** The origin the Family reaches the Instance at; the redirect URI lies below it. */
  publicBaseUrl: string;
};

export type SingleSignOnDeps = {
  /** Null when no Identity Provider is configured. */
  settings: IdentityProviderSettings | null;
  client: IdentityProviderClient;
  admins: AdminAccess;
};

/** Where the Identity Provider sends an Admin back to, below the public base URL. */
export const singleSignOnCallbackPath = "/sso/callback";

export const defaultRequiredGroup = "homelab-admin";

export type SingleSignOnSignInResult =
  | { ok: true; sessionToken: string }
  | {
      ok: false;
      problem: "sso-failed" | "sso-not-in-group" | "sso-email-unverified" | "sso-conflict";
    };

export function createSingleSignOn(deps: SingleSignOnDeps) {
  const { settings, client, admins } = deps;

  const at = (origin: string): IdentityProviderSettings | null =>
    settings !== null && settings.publicBaseUrl === origin ? settings : null;

  const connectionOf = (offered: IdentityProviderSettings) => ({
    issuerUrl: offered.issuerUrl,
    clientId: offered.clientId,
    clientSecret: offered.clientSecret,
  });

  return {
    /** Whether single sign-on is offered to someone who reached the Instance at `origin`. */
    isOfferedAt(origin: string): boolean {
      return at(origin) !== null;
    },

    /** Where to send an Admin to sign in, with what to remember until they return; null if it is not offered at `origin`. */
    async begin(origin: string): Promise<{ authorizationUrl: string; pending: PendingSignIn } | null> {
      const offered = at(origin);
      if (!offered) return null;
      return client.begin(connectionOf(offered), offered.publicBaseUrl + singleSignOnCallbackPath);
    },

    /**
     * Signs in the Admin the provider sent back, if they belong to the required group; on an
     * Instance without Admins yet, they become its first.
     */
    async complete(input: { origin: string; query: string; pending: PendingSignIn }): Promise<SingleSignOnSignInResult> {
      const offered = at(input.origin);
      if (!offered) return { ok: false, problem: "sso-failed" };
      const redirectUri = offered.publicBaseUrl + singleSignOnCallbackPath;
      const identity = await client.complete(connectionOf(offered), redirectUri, redirectUri + input.query, input.pending);
      if (!identity) return { ok: false, problem: "sso-failed" };
      // Checked at every sign-in; leaving the group ends no running session.
      if (!identity.groups.includes(offered.requiredGroup)) return { ok: false, problem: "sso-not-in-group" };
      const result = await admins.signInThroughIdentityProvider(identity);
      if (result.ok) return result;
      return {
        ok: false,
        problem: result.problem === "identity-conflict" ? "sso-conflict" : "sso-email-unverified",
      };
    },
  };
}

export type SingleSignOn = ReturnType<typeof createSingleSignOn>;

export type IdentityProviderVariables = {
  issuerUrl?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  requiredGroup?: string | undefined;
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
        | "invalid-public-url";
    };

const maximumTextLength = 200;

type SettingsProblem = Extract<ParsedIdentityProviderSettings, { ok: false }>["problem"];

/** Each setting, checked in turn: its value, or null with the problem it has. */
const settingCheckers: {
  [K in keyof IdentityProviderSettings]: [SettingsProblem, (variables: IdentityProviderVariables) => string | null];
} = {
  issuerUrl: ["invalid-issuer-url", (v) => httpUrl(v.issuerUrl ?? "", { keepPath: true })],
  clientId: ["invalid-client-id", (v) => shortText(v.clientId ?? "")],
  clientSecret: ["client-secret-missing", (v) => (v.clientSecret ?? "").trim() || null],
  requiredGroup: ["invalid-required-group", (v) => shortText(v.requiredGroup ?? defaultRequiredGroup)],
  publicBaseUrl: ["invalid-public-url", (v) => httpUrl(v.publicBaseUrl ?? "", { keepPath: false })],
};

/** The Identity Provider the variables configure; none when the issuer is not set. */
export function parseIdentityProviderSettings(variables: IdentityProviderVariables): ParsedIdentityProviderSettings {
  if (!variables.issuerUrl?.trim()) return { ok: true, settings: null };
  const settings: Partial<IdentityProviderSettings> = {};
  for (const [key, [problem, check]] of Object.entries(settingCheckers) as [keyof IdentityProviderSettings, (typeof settingCheckers)[keyof IdentityProviderSettings]][]) {
    const value = check(variables);
    if (value === null) return { ok: false, problem };
    settings[key] = value;
  }
  return { ok: true, settings: settings as IdentityProviderSettings };
}

function shortText(text: string): string | null {
  const trimmed = text.trim();
  return isShortText(trimmed) ? trimmed : null;
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
