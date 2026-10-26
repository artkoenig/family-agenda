export type Config = {
  databaseUrl: string;
  masterKeyFile: string;
  blobDirectory: string;
  /** The `plugins/` volume, for Source plugins an operator adds to a stock image. */
  pluginDirectory: string;
  /** The version of Family Butler, if the image sets one; otherwise the package's. */
  applicationVersion?: string;
  port: number;
  trustProxy: boolean;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return {
    databaseUrl,
    masterKeyFile: env.MASTER_KEY_FILE ?? "/var/lib/family-butler/master-key/master.key",
    blobDirectory: env.BLOB_DIRECTORY ?? "/var/lib/family-butler/blobs",
    pluginDirectory: env.PLUGIN_DIRECTORY ?? "/var/lib/family-butler/plugins",
    ...(env.FAMILY_BUTLER_VERSION ? { applicationVersion: env.FAMILY_BUTLER_VERSION } : {}),
    port: Number(env.PORT ?? 3000),
    trustProxy: env.TRUST_PROXY === "true",
  };
}
