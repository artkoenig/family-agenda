import { parseIdentityProviderSettings, type IdentityProviderSettings } from "@family-agenda/application";
import { parsePluginUrls, type PluginBinding } from "./plugin-containers/bindings";
import { versionOf } from "./version";

export type Config = {
  databaseUrl: string;
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

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const publicUrl = publicUrlOf(env.PUBLIC_URL);
  const pluginContainers = parsePluginUrls(env.PLUGIN_URLS);
  return {
    databaseUrl,
    masterKeyFile: env.MASTER_KEY_FILE ?? "/var/lib/family-agenda/master-key/master.key",
    blobDirectory: env.BLOB_DIRECTORY ?? "/var/lib/family-agenda/blobs",
    pluginContainers,
    egressTicketKey: egressTicketKeyOf(env, pluginContainers),
    tessdataDirectory: env.TESSDATA_DIRECTORY ?? "/var/lib/family-agenda/tessdata",
    bundledTessdataDirectory: (env.BUNDLED_TESSDATA_DIRECTORY ?? "/usr/share/tesseract-ocr/5/tessdata") || null,
    port: Number(env.PORT ?? 3000),
    trigger: triggerConfigOf(env),
    trustProxy: env.TRUST_PROXY === "true",
    publicUrl,
    identityProvider: identityProviderOf(env, publicUrl),
    version: versionOf(env),
  };
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
