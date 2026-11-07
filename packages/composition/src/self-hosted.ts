import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  Argon2idPasswordHasher,
  CommandLineTextExtractor,
  connectPostgres,
  EnvelopeSecretStore,
  FileBlobStore,
  masterKeyLength,
  OidcIdentityProviderClient,
  OpenAiCompatibleExtractor,
  readMasterKey,
  SystemClock,
  TessdataDirectory,
  tessdataFastCatalog,
  type PostgresPoolOptions,
  type TessdataCatalog,
} from "@family-agenda/adapters";
import type { Adapters } from "./adapters";

const defaultWorkspacePackages = fileURLToPath(new URL("../../../packages", import.meta.url));

/** What an Instance on its own server, with Postgres and volumes, needs to know. */
export type SelfHostedConfig = {
  databaseUrl: string;
  pool?: PostgresPoolOptions;
  /** The 32-byte key Source credentials are encrypted with. */
  masterKey: Buffer;
  /** Where files such as photos are kept, outside Postgres. */
  blobDirectory: string;
  /** The `plugins/` volume, for Source plugins an operator adds to a stock image. */
  pluginDirectory: string;
  /** The `tessdata` volume of Tesseract models, bundled and downloaded (ADR-0012). */
  tessdataDirectory: string;
  /** Where the image keeps the Tesseract models it ships, linked into the volume on start. */
  bundledTessdataDirectory: string | null;
  /** Replaces downloading from `tessdata_fast`. */
  tessdataCatalog?: TessdataCatalog;
  /** Where the Source plugins shipped with Family Agenda are; by default the workspace's packages. */
  workspacePackages?: string;
};

/** Today's adapters: Postgres, files in volumes, the system clock and the real tools. */
export async function selfHostedAdapters(config: SelfHostedConfig): Promise<Adapters> {
  const postgres = connectPostgres(config.databaseUrl, config.pool);
  try {
    const ocrModels = new TessdataDirectory({
      directory: config.tessdataDirectory,
      bundledDirectory: config.bundledTessdataDirectory,
      catalog: config.tessdataCatalog ?? tessdataFastCatalog(),
    });
    await mkdir(config.tessdataDirectory, { recursive: true });
    await ocrModels.linkBundled();
    return {
      postgres,
      masterKey: config.masterKey,
      clock: new SystemClock(),
      passwordHasher: new Argon2idPasswordHasher(),
      identityProviderClient: new OidcIdentityProviderClient(),
      secrets: new EnvelopeSecretStore(postgres.db, config.masterKey),
      blobs: new FileBlobStore(config.blobDirectory),
      extractor: new OpenAiCompatibleExtractor(),
      textExtractor: new CommandLineTextExtractor({ tessdataDirectory: config.tessdataDirectory }),
      ocrModels,
      pluginDirectories: [config.workspacePackages ?? defaultWorkspacePackages, config.pluginDirectory],
    };
  } catch (error) {
    await postgres.close();
    throw error;
  }
}

/**
 * The master key from `MASTER_KEY` (base64) or else from the existing file `MASTER_KEY_FILE`.
 * Neither creates one: a key made up on the spot could not read what an earlier one encrypted.
 */
export async function readMasterKeyFrom(env: NodeJS.ProcessEnv): Promise<Buffer> {
  if (env.MASTER_KEY) {
    const key = Buffer.from(env.MASTER_KEY, "base64");
    if (key.length !== masterKeyLength) {
      throw new Error(`MASTER_KEY does not hold a ${masterKeyLength}-byte key in base64. Create one with: openssl rand -base64 ${masterKeyLength}`);
    }
    return key;
  }
  const file = env.MASTER_KEY_FILE;
  const key = file ? await readMasterKey(file) : null;
  if (key) return key;
  throw new Error(
    "The master key is not set. Set MASTER_KEY to a base64 key of 32 bytes, such as one from: openssl rand -base64 32" +
      (file ? `, or put the existing key file at ${file}.` : "."),
  );
}

/** Reads the self-hosted setup from environment variables. */
export async function readSelfHostedConfig(env: NodeJS.ProcessEnv = process.env): Promise<SelfHostedConfig> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  return {
    databaseUrl,
    masterKey: await readMasterKeyFrom(env),
    blobDirectory: env.BLOB_DIRECTORY ?? "/var/lib/family-agenda/blobs",
    pluginDirectory: env.PLUGIN_DIRECTORY ?? "/var/lib/family-agenda/plugins",
    tessdataDirectory: env.TESSDATA_DIRECTORY ?? "/var/lib/family-agenda/tessdata",
    bundledTessdataDirectory: (env.BUNDLED_TESSDATA_DIRECTORY ?? "/usr/share/tesseract-ocr/5/tessdata") || null,
  };
}
