import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TessdataCatalog } from "@family-agenda/adapters";
import type { BlobStore, Extractor, SecretStore, TextExtractor } from "@family-agenda/application";
import { bootApplication, type Application, type ApplicationConfig } from "../../src/composition-root";
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
  /** Test plugins installed as workspace packages before the first boot. */
  sourcePlugins?: TestPluginPackage[];
};

export type TestInstance = {
  app: Application;
  clock: FakeClock;
  /** The file the master key is kept in, outside Postgres. */
  masterKeyFile: string;
  /** Where the SourceRegistry finds workspace packages, which hold no plugins at first. */
  workspacePackages: string;
  /** The `plugins/` volume, empty at first. */
  pluginDirectory: string;
  /** The `tessdata` volume, holding links to the bundled `deu`, `eng` and `osd` models at first. */
  tessdataDirectory: string;
  /** Runs SQL against the Instance's database, to look at what it stores. */
  query(sql: string): Promise<Record<string, unknown>[]>;
  /**
   * Stops the application and boots it again on the same database, master key file and plugin
   * directories, as an update would.
   */
  restart(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Boots the application through the real composition root against a throwaway in-process
 * Postgres database (PGlite, no server needed) and master key file, with a controllable Clock.
 */
export async function bootForTest(options: TestOptions = {}): Promise<TestInstance> {
  const postgres = await acquirePostgres();
  const keyDirectory = await mkdtemp(join(tmpdir(), "family-agenda-test-"));

  const workspacePackages = join(keyDirectory, "packages");
  const pluginDirectory = join(keyDirectory, "plugins");
  await mkdir(workspacePackages);
  await mkdir(pluginDirectory);
  // The models the image ships, as stand-ins: the use cases never run Tesseract.
  const bundledTessdataDirectory = join(keyDirectory, "bundled-tessdata");
  await mkdir(bundledTessdataDirectory);
  for (const model of ["deu", "eng", "osd"]) {
    await writeFile(join(bundledTessdataDirectory, `${model}.traineddata`), `bundled ${model} model`);
  }
  const { sourcePlugins = [], ...applicationOptions } = options;
  for (const plugin of sourcePlugins) await writeTestPluginPackage(workspacePackages, plugin);

  const clock = new FakeClock(new Date("2026-09-14T07:00:00Z"));
  const config: ApplicationConfig = {
    connectDatabase: () => postgres.connect(),
    masterKeyFile: join(keyDirectory, "master.key"),
    blobDirectory: join(keyDirectory, "blobs"),
    workspacePackages,
    pluginDirectory,
    tessdataDirectory: join(keyDirectory, "tessdata"),
    bundledTessdataDirectory,
    timeZone: "Europe/Berlin",
    clock,
    ...applicationOptions,
  };

  const instance: TestInstance = {
    app: await bootApplication(config),
    clock,
    masterKeyFile: config.masterKeyFile,
    workspacePackages,
    pluginDirectory,
    tessdataDirectory: config.tessdataDirectory,
    query: (sql) => postgres.query(sql),
    async restart() {
      const stopped = instance.app;
      await stopped.close();
      // Already closed, should booting again fail.
      instance.app = { ...stopped, close: () => Promise.resolve() };
      instance.app = await bootApplication(config);
    },
    async close() {
      await instance.app.close();
      await postgres.release();
      await rm(keyDirectory, { recursive: true, force: true });
    },
  };
  return instance;
}
