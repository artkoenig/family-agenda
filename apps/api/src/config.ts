import { logtoOrganizations, parseFamilyId, type FamilyId } from "@family-agenda/adapters";
import { readFileSync } from "node:fs";
import { parseFamilyIdClaim, parseIdentityDirectorySettings, parseIdentityProviderConnection, parseIdentityProviderSettings, type IdentityDirectorySettings, type IdentityProviderConnectionSettings, type OrganizationsClaim, type IdentityProviderSettings, type LlmEndpoint } from "@family-agenda/application";
import { parsePluginUrls, type PluginBinding } from "./plugin-containers/bindings";
import type { ContractLink, ContractLinkKind } from "./http/contract-links";
import type { LegalLink, LegalLinkKind } from "./http/legal-links";
import { versionOf } from "./version";

export type Config = {
  databaseUrl: string;
  /** The Family id to write for a database that has none yet, from `FAMILY_ID`; a random UUID if not set. */
  familyId?: FamilyId;
  masterKeyFile: string;
  blobDirectory: string;
  /** Source Types whose plugins run in containers, from `PLUGIN_URLS` such as `demo=http://demo:8080`. */
  pluginContainers: PluginBinding[];
  /**
   * The key the tickets of plugin calls are signed with, from `EGRESS_TICKET_KEY`, shared with the
   * egress proxies; required with plugin containers.
   */
  egressTicketKey: string | null;
  /** The `tessdata` volume of Tesseract models. */
  tessdataDirectory: string;
  /** Where the image keeps the Tesseract models it ships; empty for none. */
  bundledTessdataDirectory: string | null;
  port: number;
  /** The Triggered operations' listener, never published by the compose file. */
  trigger: TriggerConfig;
  trustProxy: boolean;
  /**
   * The address the Family reaches the Instance at, such as `http://192.168.1.10:8080`, without a
   * trailing slash; null to use the one a request came by. Its path, such as `/agenda`, is the path
   * prefix the Instance is served below.
   */
  publicUrl: string | null;
  /** The Identity Provider from the `OIDC_*` variables, below `PUBLIC_URL`; null when `OIDC_ISSUER_URL` is not set. */
  identityProvider: IdentityProviderSettings | null;
  /**
   * The Identity Provider's management API from the `IDP_MANAGEMENT_*` variables (ADR-0010), which
   * switches on registration and the Admins page; null when none of them is set.
   */
  identityDirectory: IdentityDirectorySettings | null;
  /**
   * The key the Identity Provider signs its registration events with, from `IDP_WEBHOOK_SECRET`
   * (ADR-0010); required with the management API, null without it, which leaves `POST /idp/events` off.
   */
  idpWebhookSecret: string | null;
  /**
   * The LLM endpoint every Family extracts through, from the `LLM_*` variables; null when none is set,
   * and each Family's Admins save their own.
   */
  suppliedLlmEndpoint: LlmEndpoint | null;
  /** The release the image was built from, such as `0.3.1` or `main-1a2b3c4`; `dev` for a build from the working tree. */
  version: string;
  /**
   * The operator's legal pages every page links to, from `IMPRINT_URL`, `PRIVACY_URL` and
   * `TERMS_URL` in that order; empty when none is set.
   */
  legalLinks: LegalLink[];
  /**
   * The operator's contract pages the Admin area links to, from `CANCEL_URL`, `WITHDRAW_URL` and
   * `DELETE_URL` in that order; empty when none is set.
   */
  contractLinks: ContractLink[];
};

export type TriggerConfig = {
  /** From `TRIGGER_PORT`, 3001 by default. */
  port: number;
  /** The Bearer token every trigger must carry, from `TRIGGER_TOKEN`; null leaves the listener off. */
  token: string | null;
};

/**
 * How the core learns which Family a request is for (ADR-0003), from `CONTEXT_MODE`: `fixed`, the
 * default, serves the one Family the environment names; `supplied` serves the Family whose Context
 * each request carries, sealed with `CONTEXT_KEY`.
 */
export type ContextMode = "fixed" | "supplied";

/**
 * The shortest shared key, the ticket key as the Context key: the generator writes 24 random bytes
 * as 32 characters.
 */
export const minimumKeyLength = 32;

/** The settings of the one Family of a fixed core, by the variable each comes from; supplied mode refuses them all. */
const familyVariables = {
  databaseUrl: "DATABASE_URL",
  familyId: "FAMILY_ID",
  masterKeyFile: "MASTER_KEY_FILE",
  blobDirectory: "BLOB_DIRECTORY",
} as const;

/** What only a fixed core has: its Family and its pages port. */
type FixedOnly = keyof typeof familyVariables | "port";

/** What supplied mode refuses in the environment, and why: each Context carries its address, and the Family claim decides (ADR-0009). */
const suppliedRefusals = {
  PUBLIC_URL: "every Context carries its Family's public address",
  OIDC_REQUIRED_GROUP: `the claim OIDC_FAMILY_ID_CLAIM names decides who may sign in, and no group is checked`,
  OIDC_GROUPS_CLAIM: `the claim OIDC_FAMILY_ID_CLAIM names decides who may sign in, and no group is checked`,
} as const;

/** Variables of earlier releases that mean nothing any more: refused rather than ignored, so that no one relies on them. */
const retiredVariables = {
  OIDC_KNOWN_ADMINS_ONLY: "Admins exist only in the Identity Provider (ADR-0009), so every sign-in is checked against OIDC_REQUIRED_GROUP alone",
} as const;

/** Refuses a variable no release reads any more. */
function checkRetiredVariables(env: NodeJS.ProcessEnv): void {
  for (const [variable, reason] of Object.entries(retiredVariables)) {
    if (env[variable] !== undefined) throw new Error(`${variable} is not a known variable: ${reason}; unset it`);
  }
}


/** The mode `CONTEXT_MODE` chooses, refusing a Context key without supplied mode and the other way round. */
export function readMode(env: NodeJS.ProcessEnv = process.env): ContextMode {
  const mode = env.CONTEXT_MODE || "fixed";
  if (mode !== "fixed" && mode !== "supplied") throw new Error(`CONTEXT_MODE must be fixed or supplied, not "${mode}"`);
  checkContextKey(mode, env.CONTEXT_KEY ?? "");
  return mode;
}

/** Refuses a Context key in fixed mode, and supplied mode without a long enough one. */
function checkContextKey(mode: ContextMode, key: string): void {
  if (mode === "fixed") {
    if (key !== "") throw new Error("CONTEXT_KEY is set, but CONTEXT_MODE is not supplied; set CONTEXT_MODE=supplied, or unset CONTEXT_KEY");
    return;
  }
  if (key === "") throw new Error("CONTEXT_KEY must be set with CONTEXT_MODE=supplied");
  if (key.length < minimumKeyLength) throw new Error(`CONTEXT_KEY must be at least ${minimumKeyLength} characters long`);
}

/** A core in supplied mode: what it shares among the Families, and no Family of its own. */
export type SuppliedConfig = Omit<Config, FixedOnly | "publicUrl" | "identityProvider"> & {
  /** The one Identity Provider of the deployment, from the `OIDC_*` variables (ADR-0009); every Family's sign-in returns to `OIDC_CALLBACK_URL`. */
  identityProvider: SuppliedIdentityProvider;
  /** The key the trusted caller seals Contexts with, from `CONTEXT_KEY`. */
  contextKey: string;
  /**
   * The caller port, from `CALLER_PORT`: the only listener, where the trusted caller alone sends
   * requests with their Context; never published. No listener opens on `PORT`.
   */
  callerPort: number;
  /** The `family.created` webhook to the platform (ADR-0010); null keeps registration off. */
  familyWebhook: FamilyWebhookConfig | null;
};

/** Where a supplied core tells the platform of a new Family, and where it keeps what is pending. */
export type FamilyWebhookConfig = {
  /** `FAMILY_WEBHOOK_URL`. */
  url: string;
  /** `FAMILY_WEBHOOK_SECRET`, the key the webhook is signed with. */
  secret: string;
  /**
   * `REGISTRATION_DATABASE_URL`: the database of registrations, which belong to no Family yet: the
   * events processed and the deliveries pending. Migrated as a Family's database is.
   */
  registrationDatabaseUrl: string;
};

/** What only supplied mode reads, as every registration there creates a Family. */
const familyWebhookVariables = ["FAMILY_WEBHOOK_URL", "FAMILY_WEBHOOK_SECRET", "REGISTRATION_DATABASE_URL"] as const;

/** The `family.created` webhook, none without `FAMILY_WEBHOOK_URL`; it needs the management API, its secret and the registration database. */
function familyWebhookOf(env: NodeJS.ProcessEnv, identityDirectory: IdentityDirectorySettings | null): FamilyWebhookConfig | null {
  const url = env.FAMILY_WEBHOOK_URL ?? "";
  if (url === "") return refuseWebhookPartsWithoutUrl(env);
  if (identityDirectory === null) throw new Error("FAMILY_WEBHOOK_URL is set, but IDP_MANAGEMENT_API is not: registration needs the management API");
  if (parsePublicUrl(url) === null) throw new Error("FAMILY_WEBHOOK_URL must be an http or https address, such as https://platform.example.org/hooks/family");
  return { url, secret: familyWebhookSecretOf(env.FAMILY_WEBHOOK_SECRET ?? ""), registrationDatabaseUrl: registrationDatabaseUrlOf(env.REGISTRATION_DATABASE_URL ?? "") };
}

/** No webhook: refuses its secret or database without it. */
function refuseWebhookPartsWithoutUrl(env: NodeJS.ProcessEnv): null {
  const given = familyWebhookVariables.find((variable) => env[variable]);
  if (given) throw new Error(`${given} is set, but FAMILY_WEBHOOK_URL is not: set FAMILY_WEBHOOK_URL, or unset ${given}`);
  return null;
}

function familyWebhookSecretOf(secret: string): string {
  if (secret === "") throw new Error("FAMILY_WEBHOOK_SECRET must be set with FAMILY_WEBHOOK_URL: the webhook is signed with it");
  if (secret.length < minimumKeyLength) throw new Error(`FAMILY_WEBHOOK_SECRET must be at least ${minimumKeyLength} characters long`);
  return secret;
}

function registrationDatabaseUrlOf(url: string): string {
  if (url === "") throw new Error("REGISTRATION_DATABASE_URL must be set with FAMILY_WEBHOOK_URL: it keeps the events processed and the deliveries pending");
  return url;
}

/** The Identity Provider all Families of a core in supplied mode sign in through, with the dotted path of the claim that names the Family. */
export type SuppliedIdentityProvider = IdentityProviderConnectionSettings & {
  familyIdClaim: string;
  /** With a management API: the organizations claim, which decides instead of the Family claim (ADR-0010). */
  organizations?: OrganizationsClaim;
  /** The one redirect URI of the deployment, from `OIDC_CALLBACK_URL`: every Family's sign-in returns there. */
  callbackUrl: string;
};

/** The configuration of a core in supplied mode (`CONTEXT_MODE=supplied`). */
export function readSuppliedConfig(env: NodeJS.ProcessEnv = process.env): SuppliedConfig {
  if (readMode(env) !== "supplied") throw new Error("This configuration is for CONTEXT_MODE=supplied only");
  const given = Object.values(familyVariables).find((variable) => env[variable]);
  if (given) throw new Error(`${given} must not be set with CONTEXT_MODE=supplied: every request supplies its Family's Context`);
  for (const [variable, reason] of Object.entries(suppliedRefusals)) {
    if (env[variable]) throw new Error(`${variable} must not be set with CONTEXT_MODE=supplied: ${reason}`);
  }
  const { port, ...shared } = sharedConfigOf(env);
  const identityProvider = withOrganizations(suppliedIdentityProviderOf(env), shared.identityDirectory);
  return {
    ...shared,
    identityProvider,
    contextKey: env.CONTEXT_KEY ?? "",
    callerPort: callerPortOf(env.CALLER_PORT, port),
    familyWebhook: familyWebhookOf(env, shared.identityDirectory),
  };
}

/** The one Identity Provider of a core in supplied mode, which it requires. */
function suppliedIdentityProviderOf(env: NodeJS.ProcessEnv): SuppliedIdentityProvider {
  const parsed = parseIdentityProviderConnection({ issuerUrl: env.OIDC_ISSUER_URL, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET });
  if (!parsed.ok) throw new Error(identityProviderProblems[parsed.problem]);
  if (parsed.settings === null) throw new Error("OIDC_ISSUER_URL must be set with CONTEXT_MODE=supplied: Admins sign in only through the Identity Provider (ADR-0009)");
  const familyIdClaim = parseFamilyIdClaim(env.OIDC_FAMILY_ID_CLAIM);
  if (familyIdClaim === null) throw new Error("OIDC_FAMILY_ID_CLAIM must be a claim name or a dotted path to one, such as family_id or custom_data.familyId");
  const callbackUrl = parsePublicUrl(env.OIDC_CALLBACK_URL ?? "");
  if (callbackUrl === null || new URL(callbackUrl).pathname === "/") {
    throw new Error("OIDC_CALLBACK_URL must be set with CONTEXT_MODE=supplied: the one redirect URI of the deployment, an http or https address with a path, such as https://sign-in.example.org/sso/callback");
  }
  return { ...parsed.settings, familyIdClaim, callbackUrl };
}

/** The caller port, which supplied mode requires, apart from the pages port that browsers may reach. */
function callerPortOf(value: string | undefined, pagesPort: number): number {
  const port = Number(value || Number.NaN);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("CALLER_PORT must be set to a port with CONTEXT_MODE=supplied");
  if (port === pagesPort) throw new Error("CALLER_PORT must differ from PORT: the caller port is never published");
  return port;
}

/** Refuses in fixed mode what only supplied mode reads. */
function refuseSuppliedOnly(env: NodeJS.ProcessEnv): void {
  if (env.OIDC_FAMILY_ID_CLAIM) throw new Error("OIDC_FAMILY_ID_CLAIM is set, but CONTEXT_MODE is not supplied: in fixed mode OIDC_REQUIRED_GROUP decides who may sign in; unset it");
  if (env.OIDC_CALLBACK_URL) throw new Error("OIDC_CALLBACK_URL is set, but CONTEXT_MODE is not supplied: in fixed mode the redirect URI is <PUBLIC_URL>/sso/callback; unset it");
  const webhook = familyWebhookVariables.find((variable) => env[variable]);
  if (webhook) throw new Error(`${webhook} is set, but CONTEXT_MODE is not supplied: in fixed mode the first registration creates the one Family; unset it`);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (readMode(env) === "supplied") throw new Error("CONTEXT_MODE=supplied: in supplied mode this core has no Family of its own, only the Contexts requests supply");
  refuseSuppliedOnly(env);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const shared = sharedConfigOf(env);
  const { publicUrl, identityProvider } = addressConfigOf(env);
  return {
    databaseUrl,
    ...familyIdConfigOf(env.FAMILY_ID),
    masterKeyFile: env.MASTER_KEY_FILE ?? "/var/lib/family-agenda/master-key/master.key",
    blobDirectory: env.BLOB_DIRECTORY ?? "/var/lib/family-agenda/blobs",
    ...shared,
    publicUrl,
    identityProvider: identityProvider && withOrganizations(identityProvider, shared.identityDirectory),
  };
}

/**
 * With a management API, sign-in asks for the user's organizations and admits members of the
 * Family's organization alone, in either mode (ADR-0010); the group or Family claim no longer decides.
 */
function withOrganizations<T extends object>(provider: T, directory: IdentityDirectorySettings | null): T {
  return directory === null ? provider : { ...provider, organizations: logtoOrganizations };
}

/** The address and Identity Provider of the one Family of a fixed core; in supplied mode, each Context carries its own. */
function addressConfigOf(env: NodeJS.ProcessEnv): Pick<Config, "publicUrl" | "identityProvider"> {
  const publicUrl = publicUrlOf(env.PUBLIC_URL);
  return { publicUrl, identityProvider: identityProviderOf(env, publicUrl) };
}

/** What a core reads from the environment in either mode. */
function sharedConfigOf(env: NodeJS.ProcessEnv): Omit<Config, Exclude<FixedOnly, "port"> | "publicUrl" | "identityProvider"> {
  checkRetiredVariables(env);
  const pluginContainers = parsePluginUrls(env.PLUGIN_URLS);
  return {
    pluginContainers,
    egressTicketKey: egressTicketKeyOf(env, pluginContainers),
    tessdataDirectory: env.TESSDATA_DIRECTORY ?? "/var/lib/family-agenda/tessdata",
    bundledTessdataDirectory: (env.BUNDLED_TESSDATA_DIRECTORY ?? "/usr/share/tesseract-ocr/5/tessdata") || null,
    port: Number(env.PORT ?? 3000),
    trigger: triggerConfigOf(env),
    trustProxy: env.TRUST_PROXY === "true",
    ...identityDirectoryConfigOf(env),
    suppliedLlmEndpoint: suppliedLlmEndpointOf(env),
    version: versionOf(env),
    legalLinks: operatorLinksOf(env, legalVariables),
    contractLinks: operatorLinksOf(env, contractVariables),
  };
}

/** The variable of each legal page, in the order the pages link them. */
const legalVariables: readonly (readonly [LegalLinkKind, string])[] = [
  ["imprint", "IMPRINT_URL"],
  ["privacy", "PRIVACY_URL"],
  ["terms", "TERMS_URL"],
];

/** The variable of each contract page, in the order the Admin area links them. */
const contractVariables: readonly (readonly [ContractLinkKind, string])[] = [
  ["cancel", "CANCEL_URL"],
  ["withdraw", "WITHDRAW_URL"],
  ["delete", "DELETE_URL"],
];

/** The operator's pages that are set among `variables`, each an absolute http or https address, kept as given. */
function operatorLinksOf<K extends string>(env: NodeJS.ProcessEnv, variables: readonly (readonly [K, string])[]): { kind: K; url: string }[] {
  return variables.flatMap(([kind, variable]) => {
    const url = env[variable] ?? "";
    if (url === "") return [];
    if (!isAbsoluteHttpUrl(url)) throw new Error(`${variable} must be an absolute http or https address, such as https://example.org/page`);
    return [{ kind, url }];
  });
}

function isAbsoluteHttpUrl(text: string): boolean {
  return URL.canParse(text) && /^https?:$/.test(new URL(text).protocol);
}

/** The Family id `FAMILY_ID` gives a database that has none yet; none if empty. */
function familyIdConfigOf(value: string | undefined): { familyId?: FamilyId } {
  if (!value) return {};
  const familyId = parseFamilyId(value);
  if (familyId === null) throw new Error(`FAMILY_ID must be a UUID, not "${value}"`);
  return { familyId };
}

function triggerConfigOf(env: NodeJS.ProcessEnv): TriggerConfig {
  return { port: Number(env.TRIGGER_PORT ?? 3001), token: env.TRIGGER_TOKEN || null };
}


function egressTicketKeyOf(env: NodeJS.ProcessEnv, pluginContainers: PluginBinding[]): string | null {
  const key = env.EGRESS_TICKET_KEY ?? "";
  if (key === "") {
    if (pluginContainers.length > 0) throw new Error("EGRESS_TICKET_KEY must be set with PLUGIN_URLS; generating compose.plugins.yaml writes it to .env");
    return null;
  }
  if (key.length < minimumKeyLength) throw new Error(`EGRESS_TICKET_KEY must be at least ${minimumKeyLength} characters long`);
  return key;
}

/**
 * `text` as a public address, `PUBLIC_URL` or the `publicUrl` of a Context: http or https without
 * credentials, query or fragment, and without a trailing slash; its path is the path prefix. Null
 * if it is none.
 */
export function parsePublicUrl(text: string): string | null {
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  if (!/^https?:$/.test(url.protocol) || url.username + url.password + url.search + url.hash !== "") return null;
  return url.origin + url.pathname.replace(/\/+$/, ""); // eslint-disable-line sonarjs/super-linear-regex -- single-char quantifier anchored at end is O(n)
}

function publicUrlOf(value: string | undefined): string | null {
  if (!value) return null;
  const publicUrl = parsePublicUrl(value);
  if (publicUrl === null) throw new Error("PUBLIC_URL must be an http or https address, such as http://192.168.1.10:8080 or https://home.example.org/agenda");
  return publicUrl;
}

const identityDirectoryProblems = {
  "invalid-api": "IDP_MANAGEMENT_API must be logto when any IDP_MANAGEMENT_* variable is set",
  "invalid-endpoint": "IDP_MANAGEMENT_ENDPOINT must be an http or https address without query, such as https://id.example.org",
  "client-id-missing": "IDP_MANAGEMENT_CLIENT_ID must be set when IDP_MANAGEMENT_API is",
  "client-secret-missing": "IDP_MANAGEMENT_CLIENT_SECRET must be set when IDP_MANAGEMENT_API is",
} as const;

/** The management API of ADR-0010, none without any `IDP_MANAGEMENT_*` variable; refuses an incomplete or wrong one, naming the variable. */
function identityDirectoryOf(env: NodeJS.ProcessEnv): IdentityDirectorySettings | null {
  const parsed = parseIdentityDirectorySettings({
    api: env.IDP_MANAGEMENT_API,
    endpoint: env.IDP_MANAGEMENT_ENDPOINT,
    clientId: env.IDP_MANAGEMENT_CLIENT_ID,
    clientSecret: env.IDP_MANAGEMENT_CLIENT_SECRET,
  });
  if (!parsed.ok) throw new Error(identityDirectoryProblems[parsed.problem]);
  return parsed.settings;
}

/** The management API and the webhook secret of its registration events, which come and go together. */
function identityDirectoryConfigOf(env: NodeJS.ProcessEnv): Pick<Config, "identityDirectory" | "idpWebhookSecret"> {
  const identityDirectory = identityDirectoryOf(env);
  const idpWebhookSecret = env.IDP_WEBHOOK_SECRET || null;
  if (identityDirectory !== null && idpWebhookSecret === null) {
    throw new Error("IDP_WEBHOOK_SECRET must be set when IDP_MANAGEMENT_API is: the Identity Provider signs its registration events with it");
  }
  if (identityDirectory === null && idpWebhookSecret !== null) {
    throw new Error("IDP_WEBHOOK_SECRET is set, but IDP_MANAGEMENT_API is not: registration needs the management API; set IDP_MANAGEMENT_*, or unset IDP_WEBHOOK_SECRET");
  }
  return { identityDirectory, idpWebhookSecret };
}

const identityProviderProblems = {
  "invalid-issuer-url": "OIDC_ISSUER_URL must be an http or https address without query, such as https://id.example.ts.net",
  "invalid-client-id": "OIDC_CLIENT_ID must be set when OIDC_ISSUER_URL is",
  "client-secret-missing": "OIDC_CLIENT_SECRET must be set when OIDC_ISSUER_URL is",
  "invalid-required-group": "OIDC_REQUIRED_GROUP must not be empty",
  "invalid-groups-claim": "OIDC_GROUPS_CLAIM must be a claim name such as groups or roles",
  "invalid-public-url": "PUBLIC_URL must be set when OIDC_ISSUER_URL is: the redirect URI lies below it",
} as const;

function identityProviderOf(env: NodeJS.ProcessEnv, publicUrl: string | null): IdentityProviderSettings | null {
  const parsed = parseIdentityProviderSettings({
    issuerUrl: env.OIDC_ISSUER_URL,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    requiredGroup: env.OIDC_REQUIRED_GROUP || undefined,
    groupsClaim: env.OIDC_GROUPS_CLAIM || undefined,
    publicBaseUrl: publicUrl,
  });
  if (!parsed.ok) throw new Error(identityProviderProblems[parsed.problem]);
  return parsed.settings;
}

/** What an LLM endpoint the operator supplies is read from; the API key may come from a file instead. */
const llmVariables = ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_API_KEY_FILE"] as const;

/** The LLM endpoint of every Family, none without any `LLM_*` variable; refuses a partial or wrong one, naming the variable. */
function suppliedLlmEndpointOf(env: NodeJS.ProcessEnv): LlmEndpoint | null {
  const given = llmVariables.find((variable) => env[variable]);
  if (!given) return null;
  const model = env.LLM_MODEL ?? "";
  if (!env.LLM_BASE_URL) throw new Error(`LLM_BASE_URL must be set when ${given} is`);
  if (model === "") throw new Error("LLM_MODEL must be set when LLM_BASE_URL is");
  const baseUrl = parsePublicUrl(env.LLM_BASE_URL);
  if (baseUrl === null) throw new Error("LLM_BASE_URL must be an http or https address without query, such as https://api.openai.com/v1");
  return { baseUrl, model, apiKey: llmApiKeyOf(env) };
}

/** The API key from `LLM_API_KEY` or the file `LLM_API_KEY_FILE` names; null for none. */
function llmApiKeyOf(env: NodeJS.ProcessEnv): string | null {
  const file = env.LLM_API_KEY_FILE ?? "";
  if (file === "") return env.LLM_API_KEY || null;
  if (env.LLM_API_KEY) throw new Error("LLM_API_KEY and LLM_API_KEY_FILE must not both be set");
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch (error) {
    throw new Error(`LLM_API_KEY_FILE cannot be read: ${String(error)}`, { cause: error });
  }
}
