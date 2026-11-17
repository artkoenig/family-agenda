import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { servePlugin } from "@family-agenda/plugin-kit/server";
import type { TessdataCatalog } from "@family-agenda/adapters";
import type { SourceTypeId } from "@family-agenda/domain";
import type {
  BlobStore,
  Extractor,
  IdentityProviderClient,
  IdentityProviderSettings,
  SecretStore,
  TextExtractor,
} from "@family-agenda/application";
import { fromPglite, type TestClock } from "pg-boss";
import { PgBossWorkRunner } from "@family-agenda/adapters";
import type { WorkLog } from "../../src/background-work";
import type { TriggeredWork } from "../../src/triggered-operations";
import {
  bootFamily,
  bootShared,
  bootWorker,
  type Application,
  type ApplicationConfig,
  type SharedWiring,
} from "../../src/composition-root";
import { FakeClock } from "./fake-clock";
import { acquirePostgres } from "./in-process-postgres";
import { testSourcePlugin, type TestPluginPackage } from "./test-source-plugin";

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
  /** The Identity Provider the environment would configure; none by default. */
  identityProvider?: IdentityProviderSettings;
  /** Replaces the OIDC client, such as with a `ScriptedIdentityProviderClient`. */
  identityProviderClient?: IdentityProviderClient;
  /** Source Types whose plugins run as servers, such as fakes built with plugin-kit. */
  pluginContainers?: NonNullable<ApplicationConfig["pluginContainers"]>;
  /** Shorter timeouts than the plugin contract's, for a plugin that does not answer. */
  pluginContainerOptions?: NonNullable<ApplicationConfig["pluginContainerOptions"]>;
  /** The key plugin calls' tickets are signed with; a random one by default. */
  egressTicketKey?: string;
  /** Shorter turns of Sources' runs than in production, for a test that outlasts one. */
  sourceRunTurns?: NonNullable<ApplicationConfig["sourceRunTurns"]>;
  /** The key the Identity Provider signs its registration events with; none by default. */
  idpWebhookSecret?: string | null;
  /** Replaces what a registration does, such as with a recording one. */
  registration?: NonNullable<ApplicationConfig["registration"]>;
  /** Replaces the Identity Provider's management API, such as with an `InMemoryIdentityDirectory`; none by default. */
  identityDirectoryClient?: NonNullable<ApplicationConfig["identityDirectoryClient"]>;
  /** Test plugins served before the first boot, as plugin containers. */
  sourcePlugins?: TestPluginPackage[];
};

/** A second Family the same process serves, against a database and stores of its own. */
export type SecondFamily = {
  app: Application;
  /** Runs SQL against this Family's database. */
  query(sql: string): Promise<Record<string, unknown>[]>;
};

export type TestInstance = {
  /** What the Triggered operations act on: the booted Family's work, and Preparing the Family on its database. */
  triggeredWork(): TriggeredWork;
  app: Application;
  clock: FakeClock;
  /** The file the master key is kept in, outside Postgres. */
  masterKeyFile: string;
  /** The `blobs` volume, holding a folder of blobs per Family unless a BlobStore replaces it. */
  blobDirectory: string;
  /** The `tessdata` volume, holding links to the bundled `deu`, `eng` and `osd` models at first. */
  tessdataDirectory: string;
  /** Runs SQL against the Instance's database, to look at what it stores. */
  query(sql: string): Promise<Record<string, unknown>[]>;
  /** Serves a test plugin, in place of one of the same Source Type, from the next `restart()` on. */
  installPlugin(plugin: TestPluginPackage): Promise<void>;
  /** Stops binding a Source Type to its plugin, from the next `restart()` on. */
  uninstallPlugin(sourceTypeId: string): void;
  /**
   * Stops the application and boots it again on the same database, master key file and plugin
   * containers, as an update would.
   */
  restart(): Promise<void>;
  /**
   * Boots a second `api` container against the same database, master key file, plugin containers and
   * Clock; it is closed with the Instance.
   */
  bootApiContainer(): Promise<Application>;
  /**
   * Boots a `worker` container against the same database, its pg-boss schedules on `schedules`
   * and logging to `log`; it is closed with the Instance.
   */
  bootWorker(schedules: TestClock, log: WorkLog): Promise<Application>;
  /**
   * Boots a second Family in the same process, sharing its plugin bindings, extractors, OCR models
   * and Clock, against a database, master key file and blob directory of its own; it is closed with
   * the Instance.
   */
  bootSecondFamily(): Promise<SecondFamily>;
  close(): Promise<void>;
};

/**
 * Boots the application through the real composition root against a throwaway in-process
 * Postgres database (PGlite, no server needed) and master key file, with a controllable Clock.
 */
export async function bootForTest(options: TestOptions = {}): Promise<TestInstance> {
  const postgres = await acquirePostgres();
  const keyDirectory = await mkdtemp(join(tmpdir(), "family-agenda-test-"));
  // The models the image ships, as stand-ins: the use cases never run Tesseract.
  const bundledTessdataDirectory = join(keyDirectory, "bundled-tessdata");
  await mkdir(bundledTessdataDirectory);
  for (const model of ["deu", "eng", "osd"]) {
    await writeFile(join(bundledTessdataDirectory, `${model}.traineddata`), `bundled ${model} model`);
  }
  const { sourcePlugins = [], pluginContainers = [], ...applicationOptions } = options;
  const servers: Server[] = [];
  const bindings = [...pluginContainers];
  const uninstallPlugin = (sourceTypeId: string): void => {
    const index = bindings.findIndex((binding) => binding.sourceTypeId === sourceTypeId);
    if (index >= 0) bindings.splice(index, 1);
  };
  const installPlugin = async (plugin: TestPluginPackage): Promise<void> => {
    const server = await servePlugin(testSourcePlugin(plugin), { host: "127.0.0.1" });
    servers.push(server);
    uninstallPlugin(plugin.sourceTypeId);
    bindings.push({ sourceTypeId: plugin.sourceTypeId as SourceTypeId, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  };
  for (const plugin of sourcePlugins) await installPlugin(plugin);

  const clock = new FakeClock(new Date("2026-09-14T07:00:00Z"));
  const config: ApplicationConfig = {
    connectDatabase: () => postgres.connect(),
    masterKeyFile: join(keyDirectory, "master.key"),
    blobDirectory: join(keyDirectory, "blobs"),
    tessdataDirectory: join(keyDirectory, "tessdata"),
    bundledTessdataDirectory,
    timeZone: "Europe/Berlin",
    clock,
    pluginContainers: bindings,
    ...applicationOptions,
  };

  const otherContainers: Application[] = [];
  const otherDatabases: Awaited<ReturnType<typeof acquirePostgres>>[] = [];
  // What the process shares among its Families, wired again on each restart.
  let shared: SharedWiring = await bootShared(config);
  const instance: TestInstance = {
    app: await bootFamily(shared, config),
    clock,
    masterKeyFile: config.masterKeyFile,
    blobDirectory: config.blobDirectory,
    tessdataDirectory: config.tessdataDirectory,
    query: (sql) => postgres.query(sql),
    triggeredWork: () => ({
      dueWork: instance.app.dueWork,
      retention: instance.app.retention,
      secretSweep: instance.app.secretSweep,
      admins: instance.app.admins,
    }),
    installPlugin,
    uninstallPlugin,
    async restart() {
      const stopped = instance.app;
      await stopped.close();
      // Already closed, should booting again fail.
      instance.app = { ...stopped, close: () => Promise.resolve() };
      shared = await bootShared(config);
      instance.app = await bootFamily(shared, config);
    },
    async bootApiContainer() {
      const container = await bootFamily(await bootShared(config), config);
      otherContainers.push(container);
      return container;
    },
    async bootWorker(schedules, log) {
      const workRunner = new PgBossWorkRunner({ db: fromPglite(postgres.pglite), backend: "pglite", clock: schedules }, log);
      const worker = await bootWorker({ ...config, workRunner, log });
      otherContainers.push(worker);
      return worker;
    },
    async bootSecondFamily() {
      const database = await acquirePostgres();
      otherDatabases.push(database);
      // Databases come from one snapshot, and so with the same Family id at first.
      await database.query("update family set family_id = gen_random_uuid()");
      const directory = await mkdtemp(join(keyDirectory, "second-family-"));
      const app = await bootFamily(shared, {
        connectDatabase: () => database.connect(),
        masterKeyFile: join(directory, "master.key"),
        blobDirectory: join(directory, "blobs"),
        timeZone: "Europe/Berlin",
      });
      otherContainers.push(app);
      return { app, query: (sql) => database.query(sql) };
    },
    async close() {
      for (const container of otherContainers) await container.close();
      await instance.app.close();
      await postgres.release();
      for (const database of otherDatabases) await database.release();
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      await rm(keyDirectory, { recursive: true, force: true });
    },
  };
  return instance;
}
