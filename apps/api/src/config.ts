import { parseFamilyId, type FamilyId } from "@family-agenda/adapters";
import { parseIdentityProviderSettings, type IdentityProviderSettings } from "@family-agenda/application";
import { parsePluginUrls, type PluginBinding } from "./plugin-containers/bindings";
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
  /** The release the image was built from, such as `0.3.1` or `main-1a2b3c4`; `dev` for a build from the working tree. */
  version: string;
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

/** The shortest Context key, as for the ticket key. */
const minimumContextKeyLength = 32;

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
  if (key.length < minimumContextKeyLength) throw new Error(`CONTEXT_KEY must be at least ${minimumContextKeyLength} characters long`);
}

/** A core in supplied mode: what it shares among the Families, and no Family of its own. */
export type SuppliedConfig = Omit<Config, "databaseUrl" | "familyId" | "masterKeyFile" | "blobDirectory" | "trigger"> & {
  /** The key the trusted caller seals Contexts with, from `CONTEXT_KEY`. */
  contextKey: string;
};

/** The variables that name a fixed Family, which supplied mode never falls back to. */
const fixedFamilyVariables = ["DATABASE_URL", "FAMILY_ID", "MASTER_KEY_FILE", "BLOB_DIRECTORY"] as const;

/** The configuration of a core in supplied mode (`CONTEXT_MODE=supplied`). */
export function readSuppliedConfig(env: NodeJS.ProcessEnv = process.env): SuppliedConfig {
  if (readMode(env) !== "supplied") throw new Error("This configuration is for CONTEXT_MODE=supplied only");
  const given = fixedFamilyVariables.find((variable) => env[variable]);
  if (given) throw new Error(`${given} must not be set with CONTEXT_MODE=supplied: every request supplies its Family's Context`);
  return { ...sharedConfigOf(env), contextKey: env.CONTEXT_KEY ?? "" };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (readMode(env) === "supplied") throw new Error("CONTEXT_MODE=supplied: in supplied mode this core has no Family of its own, only the Contexts requests supply");
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return {
    databaseUrl,
    ...familyIdConfigOf(env.FAMILY_ID),
    masterKeyFile: env.MASTER_KEY_FILE ?? "/var/lib/family-agenda/master-key/master.key",
    blobDirectory: env.BLOB_DIRECTORY ?? "/var/lib/family-agenda/blobs",
    trigger: triggerConfigOf(env),
    ...sharedConfigOf(env),
  };
}

/** What a core reads from the environment in either mode. */
function sharedConfigOf(env: NodeJS.ProcessEnv): Omit<Config, "databaseUrl" | "familyId" | "masterKeyFile" | "blobDirectory" | "trigger"> {
  const publicUrl = publicUrlOf(env.PUBLIC_URL);
  const pluginContainers = parsePluginUrls(env.PLUGIN_URLS);
  return {
    pluginContainers,
    egressTicketKey: egressTicketKeyOf(env, pluginContainers),
    tessdataDirectory: env.TESSDATA_DIRECTORY ?? "/var/lib/family-agenda/tessdata",
    bundledTessdataDirectory: (env.BUNDLED_TESSDATA_DIRECTORY ?? "/usr/share/tesseract-ocr/5/tessdata") || null,
    port: Number(env.PORT ?? 3000),
    trustProxy: env.TRUST_PROXY === "true",
    publicUrl,
    identityProvider: identityProviderOf(env, publicUrl),
    version: versionOf(env),
  };
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

/** The shortest ticket key: the generator writes 24 random bytes as 32 characters. */
const minimumTicketKeyLength = 32;

function egressTicketKeyOf(env: NodeJS.ProcessEnv, pluginContainers: PluginBinding[]): string | null {
  const key = env.EGRESS_TICKET_KEY ?? "";
  if (key === "") {
    if (pluginContainers.length > 0) throw new Error("EGRESS_TICKET_KEY must be set with PLUGIN_URLS; generating compose.plugins.yaml writes it to .env");
    return null;
  }
  if (key.length < minimumTicketKeyLength) throw new Error(`EGRESS_TICKET_KEY must be at least ${minimumTicketKeyLength} characters long`);
  return key;
}

function publicUrlOf(value: string | undefined): string | null {
  if (!value) return null;
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error("PUBLIC_URL must be an http or https address, such as http://192.168.1.10:8080 or https://home.example.org/agenda");
  }
  const url = new URL(value);
  return url.origin + url.pathname.replace(/\/+$/, ""); // eslint-disable-line sonarjs/super-linear-regex -- single-char quantifier anchored at end is O(n)
}

const identityProviderProblems = {
  "invalid-issuer-url": "OIDC_ISSUER_URL must be an http or https address without query, such as https://id.example.ts.net",
  "invalid-client-id": "OIDC_CLIENT_ID must be set when OIDC_ISSUER_URL is",
  "client-secret-missing": "OIDC_CLIENT_SECRET must be set when OIDC_ISSUER_URL is",
  "invalid-required-group": "OIDC_REQUIRED_GROUP must not be empty",
  "invalid-public-url": "PUBLIC_URL must be set when OIDC_ISSUER_URL is: the redirect URI lies below it",
} as const;

function identityProviderOf(env: NodeJS.ProcessEnv, publicUrl: string | null): IdentityProviderSettings | null {
  const parsed = parseIdentityProviderSettings({
    issuerUrl: env.OIDC_ISSUER_URL,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    requiredGroup: env.OIDC_REQUIRED_GROUP || undefined,
    publicBaseUrl: publicUrl,
  });
  if (!parsed.ok) throw new Error(identityProviderProblems[parsed.problem]);
  return parsed.settings;
}
