import { mkdir } from "node:fs/promises";
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
import type { Application } from "./application";
import type { PluginHostConfig } from "./plugin-host-client";
import { bootApplication, bootWorker, type Worker } from "./boot";
import { readApplicationConfig } from "./config";

/** What an Instance on its own server, with Postgres and volumes, needs to know. */
export type SelfHostedConfig = {
  databaseUrl: string;
  pool?: PostgresPoolOptions;
  /** The 32-byte key Source credentials are encrypted with. */
  masterKey: Buffer;
  /** Where files such as photos are kept, outside Postgres. */
  blobDirectory: string;
  /** The `tessdata` volume of Tesseract models, bundled and downloaded. */
  tessdataDirectory: string;
  /** Where the image keeps the Tesseract models it ships, linked into the volume on start. */
  bundledTessdataDirectory: string | null;
  /** Replaces downloading from `tessdata_fast`. */
  tessdataCatalog?: TessdataCatalog;
  /** The Plugin Host, which runs every Source plugin. */
  pluginHost: PluginHostConfig;
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
      pluginHost: config.pluginHost,
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
    tessdataDirectory: env.TESSDATA_DIRECTORY ?? "/var/lib/family-agenda/tessdata",
    bundledTessdataDirectory: (env.BUNDLED_TESSDATA_DIRECTORY ?? "/usr/share/tesseract-ocr/5/tessdata") || null,
    pluginHost: pluginHostFrom(env),
  };
}

/** Boots an Application from the environment, as `api` and the CLI do. */
export async function bootSelfHosted(env: NodeJS.ProcessEnv = process.env): Promise<Application> {
  return bootApplication(readApplicationConfig(env), await selfHostedAdapters(await readSelfHostedConfig(env)));
}

/** Boots the Worker from the environment. */
export async function bootSelfHostedWorker(env: NodeJS.ProcessEnv = process.env): Promise<Worker> {
  return bootWorker(readApplicationConfig(env), await selfHostedAdapters(await readSelfHostedConfig(env)));
}

/** The Plugin Host from PLUGIN_HOST_URL and PLUGIN_HOST_TOKEN, which are both needed. */
export function pluginHostFrom(env: NodeJS.ProcessEnv): PluginHostConfig {
  const url = env.PLUGIN_HOST_URL;
  const token = env.PLUGIN_HOST_TOKEN;
  if (!url) throw new Error("PLUGIN_HOST_URL is not set; it is where api and worker reach the Plugin Host, such as http://plugin-host:4100.");
  if (!token) throw new Error("PLUGIN_HOST_TOKEN is not set. Set it to the same random token for api, worker and plugin-host, such as one from: openssl rand -hex 32");
  return { url, token };
}
