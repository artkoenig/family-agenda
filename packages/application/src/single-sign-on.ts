import type { AdminAccess } from "./admin-access";
import type { IdentityProviderClient, OrganizationsClaim, PendingSignIn, SignInSecrets, VerifiedIdentity } from "./ports";

/** The one Identity Provider, as the operator configured it in the environment (ADR-0007). */
export type IdentityProviderSettings = {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  requiredGroup: string;
  /** The claim whose list must contain `requiredGroup`: `groups` by default, `roles` with Logto. */
  groupsClaim: string;
  /** The address the Family reaches the Instance at, its path prefix included; the redirect URI lies below it. */
  publicBaseUrl: string;
  /**
   * In supplied mode (ADR-0009): the claim at the dotted path `claim` must equal the Family's id
   * `familyId`, and no group is checked besides. Absent in fixed mode, where the group decides.
   */
  family?: FamilyClaim;
  /**
   * In supplied mode (ADR-0009): the one redirect URI of the whole deployment, `OIDC_CALLBACK_URL`,
   * which the core answers itself before handing the sign-in over to the Family's address. Absent
   * in fixed mode, where the redirect URI lies below `publicBaseUrl`.
   */
  callbackUrl?: string;
  /**
   * With a management API (ADR-0010): the ID token's organizations must contain the Family's
   * organization, in either mode, and neither group nor Family claim is checked.
   */
  organizations?: OrganizationsClaim;
};

/** The Family a sign-in must belong to, and the dotted path of the claim naming it, such as `custom_data.familyId`. */
export type FamilyClaim = { claim: string; familyId: string };

export type SingleSignOnDeps = {
  /** Null when no Identity Provider is configured. */
  settings: IdentityProviderSettings | null;
  client: IdentityProviderClient;
  admins: AdminAccess;
  /** The id of the Family's organization at the Identity Provider; null before registration created it. */
  organizationId?: () => Promise<string | null>;
};

/** Where the Identity Provider sends an Admin back to, below the public base URL and so below its path prefix. */
export const singleSignOnCallbackPath = "/sso/callback";

export const defaultRequiredGroup = "homelab-admin";

export const defaultGroupsClaim = "groups";

export const defaultFamilyIdClaim = "family_id";

export type SingleSignOnSignInResult =
  | { ok: true; sessionToken: string }
  | {
      ok: false;
      problem: "sso-failed" | "sso-not-in-group" | "sso-no-family" | "sso-other-family" | "sso-not-member" | "sso-email-unverified";
    };

export function createSingleSignOn(deps: SingleSignOnDeps) {
  const { settings, client, admins } = deps;
  const organizationId = deps.organizationId ?? (() => Promise.resolve(null));

  const at = (baseUrl: string): IdentityProviderSettings | null =>
    settings !== null && settings.publicBaseUrl === baseUrl ? settings : null;

  return {
    /** Whether single sign-on is offered to someone who reached the Instance at `baseUrl`, path prefix included. */
    isOfferedAt(baseUrl: string): boolean {
      return at(baseUrl) !== null;
    },

    /** Whether the Identity Provider sends Admins back to the one callback of the deployment, not below `baseUrl` (supplied mode). */
    returnsElsewhere(baseUrl: string): boolean {
      return at(baseUrl)?.callbackUrl !== undefined;
    },

    /**
     * Where to send an Admin to sign in, with what to remember until they return; null if it is not
     * offered at `baseUrl`. `stateOf` makes the `state` from the sign-in's secrets, a random one without.
     */
    async begin(baseUrl: string, stateOf?: (secrets: SignInSecrets) => string): Promise<{ authorizationUrl: string; pending: PendingSignIn } | null> {
      const offered = at(baseUrl);
      if (!offered) return null;
      return client.begin(connectionOf(offered), redirectUriOf(offered), stateOf);
    },

    /** The id of the Family's organization, for the `state` of a sign-in that returns elsewhere; null before there is one. */
    organizationId,

    /** Signs in someone the one callback of the deployment vouched for and handed over (supplied mode). */
    async signInHandedOver(identity: AdmittedIdentity): Promise<string> {
      return admins.startSession(identity);
    },

    /**
     * Signs in whoever the provider sent back as an Admin, if the groups claim holds the required
     * group and the email address is verified. No Admin is stored: the session is all there is (ADR-0009).
     */
    async complete(input: { baseUrl: string; query: string; pending: PendingSignIn }): Promise<SingleSignOnSignInResult> {
      const offered = at(input.baseUrl);
      if (!offered) return { ok: false, problem: "sso-failed" };
      const admitted = await completeSignIn(client, offered, input.query, input.pending, await organizationId());
      return admitted.ok ? { ok: true, sessionToken: await admins.startSession(admitted.identity) } : admitted;
    },
  };
}

/** Who may administer the Family: as the Identity Provider vouched for them, with a verified email address. */
export type AdmittedIdentity = { subject: string; email: string };

export type SignInAdmission = { ok: true; identity: AdmittedIdentity } | Extract<SingleSignOnSignInResult, { ok: false }>;

const connectionOf = (offered: IdentityProviderSettings) => ({
  issuerUrl: offered.issuerUrl,
  clientId: offered.clientId,
  clientSecret: offered.clientSecret,
  groupsClaim: offered.groupsClaim,
  ...(offered.family ? { familyIdClaim: offered.family.claim } : {}),
  ...(offered.organizations ? { organizations: offered.organizations } : {}),
});

/** The one callback of the deployment in supplied mode, else the callback below the public base URL. */
const redirectUriOf = (offered: IdentityProviderSettings) => offered.callbackUrl ?? offered.publicBaseUrl + singleSignOnCallbackPath;

/**
 * Whom the provider sent back with `query` to the redirect URI, if they may administer the Family:
 * the groups claim holds the required group, or in supplied mode the Family claim names the Family,
 * and the email address is verified. Starts no session.
 */
export async function completeSignIn(
  client: IdentityProviderClient,
  offered: IdentityProviderSettings,
  query: string,
  pending: PendingSignIn,
  organizationId: string | null = null,
): Promise<SignInAdmission> {
  const redirectUri = redirectUriOf(offered);
  const identity = await client.complete(connectionOf(offered), redirectUri, redirectUri + query, pending);
  if (!identity) return { ok: false, problem: "sso-failed" };
  // Checked at every sign-in; leaving the group or Family ends a running session only when it expires.
  const refused = admissionProblemOf(offered, identity, organizationId);
  if (refused) return { ok: false, problem: refused };
  const email = identity.email?.trim() ?? "";
  if (email === "" || !identity.emailVerified) return { ok: false, problem: "sso-email-unverified" };
  return { ok: true, identity: { subject: identity.subject, email } };
}

/**
 * Why `identity` may not administer the Family: with a management API membership of the Family's
 * organization `organizationId` decides, none before it exists; else in supplied mode the Family claim, else the required group.
 */
function admissionProblemOf(offered: IdentityProviderSettings, identity: VerifiedIdentity, organizationId: string | null): SingleSignOnRefusal | null {
  if (offered.organizations) return organizationId !== null && identity.organizations.includes(organizationId) ? null : "sso-not-member";
  if (!offered.family) return identity.groups.includes(offered.requiredGroup) ? null : "sso-not-in-group";
  if (identity.familyId === null) return "sso-no-family";
  return identity.familyId === offered.family.familyId ? null : "sso-other-family";
}

type SingleSignOnRefusal = Extract<SingleSignOnSignInResult, { ok: false }>["problem"];

export type SingleSignOn = ReturnType<typeof createSingleSignOn>;

export type IdentityProviderVariables = {
  issuerUrl?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  requiredGroup?: string | undefined;
  groupsClaim?: string | undefined;
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
        | "invalid-groups-claim"
        | "invalid-public-url";
    };

const maximumTextLength = 200;

type SettingsProblem = Extract<ParsedIdentityProviderSettings, { ok: false }>["problem"];

/** The settings any Identity Provider has, wherever its redirect URI lies. */
export type IdentityProviderConnectionSettings = Omit<IdentityProviderSettings, "publicBaseUrl" | "family" | "callbackUrl" | "organizations">;

type Checkers<T> = { [K in keyof T]-?: [SettingsProblem, (variables: IdentityProviderVariables) => string | null] };

/** Each setting, checked in turn: its value, or null with the problem it has. */
const connectionCheckers: Checkers<IdentityProviderConnectionSettings> = {
  issuerUrl: ["invalid-issuer-url", (v) => httpUrl(v.issuerUrl ?? "")],
  clientId: ["invalid-client-id", (v) => shortText(v.clientId ?? "")],
  clientSecret: ["client-secret-missing", (v) => (v.clientSecret ?? "").trim() || null],
  requiredGroup: ["invalid-required-group", (v) => shortText(v.requiredGroup ?? defaultRequiredGroup)],
  groupsClaim: ["invalid-groups-claim", (v) => claimName(v.groupsClaim ?? defaultGroupsClaim)],
};

const settingCheckers: Checkers<Omit<IdentityProviderSettings, "family" | "callbackUrl" | "organizations">> = {
  ...connectionCheckers,
  publicBaseUrl: ["invalid-public-url", (v) => httpUrl(v.publicBaseUrl ?? "")],
};

/** The Identity Provider the variables configure; none when the issuer is not set. */
export function parseIdentityProviderSettings(variables: IdentityProviderVariables): ParsedIdentityProviderSettings {
  return checked(variables, settingCheckers);
}

/**
 * As `parseIdentityProviderSettings`, without the public base URL: the one Identity Provider of a
 * core in supplied mode, whose redirect URI lies below each Family's own address (ADR-0009).
 */
export function parseIdentityProviderConnection(
  variables: IdentityProviderVariables,
): { ok: true; settings: IdentityProviderConnectionSettings | null } | Extract<ParsedIdentityProviderSettings, { ok: false }> {
  return checked(variables, connectionCheckers);
}

function checked<T>(variables: IdentityProviderVariables, checkers: Checkers<T>): { ok: true; settings: T | null } | { ok: false; problem: SettingsProblem } {
  if (!variables.issuerUrl?.trim()) return { ok: true, settings: null };
  const settings: Record<string, string> = {};
  for (const [key, [problem, check]] of Object.entries<[SettingsProblem, (v: IdentityProviderVariables) => string | null]>(checkers)) {
    const value = check(variables);
    if (value === null) return { ok: false, problem };
    settings[key] = value;
  }
  return { ok: true, settings: settings as T };
}

/** A claim name, also requested as a scope: letters, digits, `_`, `-`, `.` and `:` only. */
function claimName(text: string): string | null {
  const name = shortText(text);
  return name !== null && /^[\w.:-]+$/.test(name) ? name : null;
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

/** The dotted path `OIDC_FAMILY_ID_CLAIM` gives, `family_id` when empty; null for one with an empty or odd segment. */
export function parseFamilyIdClaim(text: string | undefined): string | null {
  const path = shortText(text || defaultFamilyIdClaim);
  return path !== null && /^[\w:-]+(?:\.[\w:-]+)*$/.test(path) ? path : null;
}
