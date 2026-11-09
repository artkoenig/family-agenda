import { parseEgressTokens, parsePluginEgress } from "./egress/allowlist";
import { parsePluginUrls, type PluginBinding } from "./plugin-containers/bindings";
import { versionOf } from "./version";

export type Config = {
  databaseUrl: string;
  masterKeyFile: string;
  blobDirectory: string;
  /** Source Types whose plugins run in containers, from `PLUGIN_URLS` such as `demo=http://demo:8080`. */
  pluginContainers: PluginBinding[];
  /** The declared egress hosts per plugin container, from `PLUGIN_EGRESS`, which their egress proxies allow. */
  pluginEgress: Map<string, string[]>;
  /** The token per egress proxy's container, from `PLUGIN_EGRESS_TOKENS`, with which it fetches its allowlist. */
  egressTokens: Map<string, string>;
  /** The `tessdata` volume of Tesseract models (ADR-0012). */
  tessdataDirectory: string;
  /** Where the image keeps the Tesseract models it ships; empty for none. */
  bundledTessdataDirectory: string | null;
  port: number;
  trustProxy: boolean;
  /** The address the Family reaches the Instance at, such as `http://192.168.1.10:8080`; null to use the one a request came by. */
  publicUrl: string | null;
  /** The release the image was built from, such as `0.3.1` or `main-1a2b3c4`; `dev` for a build from the working tree. */
  version: string;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return {
    databaseUrl,
    masterKeyFile: env.MASTER_KEY_FILE ?? "/var/lib/family-agenda/master-key/master.key",
    blobDirectory: env.BLOB_DIRECTORY ?? "/var/lib/family-agenda/blobs",
    pluginContainers: parsePluginUrls(env.PLUGIN_URLS),
    pluginEgress: parsePluginEgress(env.PLUGIN_EGRESS),
    egressTokens: parseEgressTokens(env.PLUGIN_EGRESS_TOKENS),
    tessdataDirectory: env.TESSDATA_DIRECTORY ?? "/var/lib/family-agenda/tessdata",
    bundledTessdataDirectory: (env.BUNDLED_TESSDATA_DIRECTORY ?? "/usr/share/tesseract-ocr/5/tessdata") || null,
    port: Number(env.PORT ?? 3000),
    trustProxy: env.TRUST_PROXY === "true",
    publicUrl: publicUrlOf(env.PUBLIC_URL),
    version: versionOf(env),
  };
}

function publicUrlOf(value: string | undefined): string | null {
  if (!value) return null;
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error("PUBLIC_URL must be an http or https address, such as http://192.168.1.10:8080");
  }
  return new URL(value).origin;
}
