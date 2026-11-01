export type Config = {
  databaseUrl: string;
  masterKeyFile: string;
  blobDirectory: string;
  /** The `plugins/` volume, for Source plugins an operator adds to a stock image. */
  pluginDirectory: string;
  /** The `tessdata` volume of Tesseract models (ADR-0012). */
  tessdataDirectory: string;
  /** Where the image keeps the Tesseract models it ships; empty for none. */
  bundledTessdataDirectory: string | null;
  port: number;
  trustProxy: boolean;
  /** The address the Family reaches the Instance at, such as `http://192.168.1.10:8080`; null to use the one a request came by. */
  publicUrl: string | null;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return {
    databaseUrl,
    masterKeyFile: env.MASTER_KEY_FILE ?? "/var/lib/family-agenda/master-key/master.key",
    blobDirectory: env.BLOB_DIRECTORY ?? "/var/lib/family-agenda/blobs",
    pluginDirectory: env.PLUGIN_DIRECTORY ?? "/var/lib/family-agenda/plugins",
    tessdataDirectory: env.TESSDATA_DIRECTORY ?? "/var/lib/family-agenda/tessdata",
    bundledTessdataDirectory: (env.BUNDLED_TESSDATA_DIRECTORY ?? "/usr/share/tesseract-ocr/5/tessdata") || null,
    port: Number(env.PORT ?? 3000),
    trustProxy: env.TRUST_PROXY === "true",
    publicUrl: publicUrlOf(env.PUBLIC_URL),
  };
}

function publicUrlOf(value: string | undefined): string | null {
  if (!value) return null;
  if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
    throw new Error("PUBLIC_URL must be an http or https address, such as http://192.168.1.10:8080");
  }
  return new URL(value).origin;
}
