import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Argon2idPasswordHasher,
  CommandLineTextExtractor,
  EnvelopeSecretStore,
  FileBlobStore,
  OidcIdentityProviderClient,
  OpenAiCompatibleExtractor,
  TessdataDirectory,
  tessdataFastCatalog,
  type TessdataCatalog,
} from "@family-agenda/adapters";
import type {
  BlobStore,
  Extractor,
  IdentityProviderClient,
  SecretStore,
  TextExtractor,
} from "@family-agenda/application";
import { bootApplication, type Adapters, type Application, type ApplicationConfig, type PluginHostConfig } from "@family-agenda/composition";
import { createPluginHostServer, defaultLimits, installFromRepository, MockPluginRepository, PluginManager } from "@family-agenda/plugin-host";
import { parseManifest } from "@family-agenda/source-sdk";
import { FakeClock } from "./fake-clock";
import { acquirePostgres } from "./in-process-postgres";
import { writeTestPluginPackage, type TestPluginPackage } from "./test-source-plugin";

export type TestOptions = {
  /** Replaces the envelope-encrypting SecretStore, such as with an `InMemorySecretStore`. */
  secretStore?: SecretStore;
  /** Replaces the BlobStore in a temporary directory, such as with an `InMemoryBlobStore`. */
  blobStore?: BlobStore;
  /** Replaces the OpenAI-compatible Extractor, such as with a `ScriptedExtractor`. */
  extractor?: Extractor;
  /** Replaces the poppler and Tesseract command-line tools, such as with a `FakeTextExtractor`. */
  textExtractor?: TextExtractor;
  /** Replaces downloading Tesseract models, such as with a `FakeTessdataCatalog`. */
  tessdataCatalog?: TessdataCatalog;
  /** Replaces the OIDC client, such as with a `ScriptedIdentityProviderClient`. */
  identityProviderClient?: IdentityProviderClient;
  /** The time zone of the Family; `Europe/Berlin` by default. */
  timeZone?: string;
  /** How long a plugin may take to run a Source; the Instance's default if absent. */
  pluginTimeoutMs?: number;
  /** Test plugins the Plugin Repository publishes before the first boot. */
  sourcePlugins?: TestPluginPackage[];
};

export type TestInstance = {
  app: Application;
  clock: FakeClock;
  /** The master key the Instance boots with. */
  masterKey: Buffer;
  /**
   * The packages the Plugin Repository publishes, none at first. On each boot a Plugin Host
   * installs those with a Source plugin manifest, as one would on an update.
   */
  publishedPlugins: string;
  /** The `tessdata` volume, holding links to the bundled `deu`, `eng` and `osd` models at first. */
  tessdataDirectory: string;
  /** Runs SQL against the Instance's database, to look at what it stores. */
  query(sql: string): Promise<Record<string, unknown>[]>;
  /**
   * Stops the application and boots it again on the same database and master key file, with a
   * Plugin Host installing what is published then, as an update would; with the given master key, should the operator have changed it.
   */
  restart(masterKey?: Buffer): Promise<void>;
  /**
   * Boots a second application on the same database, master key and plugin directories, with its
   * own connection, as a second worker process would; closed with the Instance.
   */
  bootAnother(): Promise<Application>;
  close(): Promise<void>;
};

/**
 * Boots the application through the real composition root against a throwaway in-process
 * Postgres database (PGlite, no server needed) with a master key and a controllable Clock.
 */
export async function bootForTest(options: TestOptions = {}): Promise<TestInstance> {
  const postgres = await acquirePostgres();
  const keyDirectory = await mkdtemp(join(tmpdir(), "family-agenda-test-"));

  const publishedPlugins = join(keyDirectory, "published");
  await mkdir(publishedPlugins);
  // The models the image ships, as stand-ins: the use cases never run Tesseract.
  const bundledTessdataDirectory = join(keyDirectory, "bundled-tessdata");
  await mkdir(bundledTessdataDirectory);
  for (const model of ["deu", "eng", "osd"]) {
    await writeFile(join(bundledTessdataDirectory, `${model}.traineddata`), `bundled ${model} model`);
  }
  const { sourcePlugins = [], timeZone = "Europe/Berlin", pluginTimeoutMs, ...applicationOptions } = options;
  for (const plugin of sourcePlugins) await writeTestPluginPackage(publishedPlugins, plugin);

  const clock = new FakeClock(new Date("2026-09-14T07:00:00Z"));
  const initialKey = randomBytes(32);
  const config: ApplicationConfig = { timeZone, ...(pluginTimeoutMs === undefined ? {} : { pluginTimeoutMs }) };
  const tessdataDirectory = join(keyDirectory, "tessdata");
  /** The adapters of the Instance, built anew on each boot as a process would on each start. */
  let pluginHost: { config: PluginHostConfig; stop(): Promise<void> } | undefined;
  /** `sharedHost` keeps the running Plugin Host, as a second process of the same Instance would. */
  const adaptersFor = async (masterKey: Buffer, { sharedHost = false } = {}): Promise<Adapters> => {
    if (!sharedHost || !pluginHost) {
      await pluginHost?.stop();
      pluginHost = await startPluginHost(publishedPlugins, await mkdtemp(join(keyDirectory, "plugin-host-")));
    }
    const host = pluginHost;
    const database = postgres.connect();
    const ocrModels = new TessdataDirectory({
      directory: tessdataDirectory,
      bundledDirectory: bundledTessdataDirectory,
      catalog: applicationOptions.tessdataCatalog ?? tessdataFastCatalog(),
    });
    await mkdir(tessdataDirectory, { recursive: true });
    await ocrModels.linkBundled();
    return {
      postgres: database,
      masterKey,
      clock,
      passwordHasher: new Argon2idPasswordHasher(),
      identityProviderClient: applicationOptions.identityProviderClient ?? new OidcIdentityProviderClient(),
      secrets: applicationOptions.secretStore ?? new EnvelopeSecretStore(database.db, masterKey),
      blobs: applicationOptions.blobStore ?? new FileBlobStore(join(keyDirectory, "blobs")),
      extractor: applicationOptions.extractor ?? new OpenAiCompatibleExtractor(),
      textExtractor: applicationOptions.textExtractor ?? new CommandLineTextExtractor({ tessdataDirectory }),
      ocrModels,
      pluginHost: host.config,
    };
  };

  const others: Application[] = [];
  const instance: TestInstance = {
    app: await bootApplication(config, await adaptersFor(initialKey)),
    clock,
    masterKey: initialKey,
    publishedPlugins,
    tessdataDirectory,
    query: (sql) => postgres.query(sql),
    async restart(masterKey = instance.masterKey) {
      const stopped = instance.app;
      await stopped.close();
      // Already closed, should booting again fail.
      instance.app = { ...stopped, close: () => Promise.resolve() };
      instance.masterKey = masterKey;
      instance.app = await bootApplication(config, await adaptersFor(masterKey));
    },
    async bootAnother() {
      const other = await bootApplication(config, await adaptersFor(instance.masterKey, { sharedHost: true }));
      others.push(other);
      return other;
    },
    async close() {
      for (const other of others) await other.close();
      await instance.app.close();
      await pluginHost?.stop();
      await postgres.release();
      // The Plugin Host leaves the plugins' directories read-only.
      execFileSync("chmod", ["-R", "u+w", keyDirectory]);
      await rm(keyDirectory, { recursive: true, force: true });
    },
  };
  return instance;
}

/** A Plugin Host on a free port, installing the plugins of the packages in `published`. */
async function startPluginHost(published: string, workDirectory: string): Promise<{ config: PluginHostConfig; stop(): Promise<void> }> {
  const manager = new PluginManager({ ...defaultLimits, workDirectory: await realpath(workDirectory), firstUserId: null });
  const repository = await MockPluginRepository.fromPackages(await pluginPackagesIn(published));
  const { available, failures } = await installFromRepository(manager, repository);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  const token = randomBytes(16).toString("hex");
  const server = createPluginHostServer(manager, token, () => available);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    config: { url: `http://127.0.0.1:${port}`, token },
    async stop() {
      manager.stop();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** The packages in `directory` that hold a Source plugin manifest, valid or not. */
async function pluginPackagesIn(directory: string): Promise<string[]> {
  const packages: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const manifest = JSON.parse(await readFile(join(directory, name, "package.json"), "utf8")) as { familyAgenda?: unknown };
    if (manifest.familyAgenda !== undefined && parseManifest(manifest).ok) packages.push(join(directory, name));
  }
  return packages;
}
