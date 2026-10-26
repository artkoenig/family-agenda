import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretStore } from "@family-butler/application";
import pg from "pg";
import { bootApplication, type Application, type ApplicationConfig } from "../../src/composition-root";
import { FakeClock } from "./fake-clock";

const serverUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

export type TestOptions = {
  /** Replaces the envelope-encrypting SecretStore, such as with an `InMemorySecretStore`. */
  secretStore?: SecretStore;
  /** The application version the Instance runs, as an update would change it. */
  applicationVersion?: string;
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
  /** Runs SQL against the Instance's database, to look at what it stores. */
  query(sql: string): Promise<Record<string, unknown>[]>;
  /**
   * Stops the application and boots it again on the same database, master key file and plugin
   * directories, with `changes` such as a new application version.
   */
  restart(changes?: Pick<TestOptions, "applicationVersion">): Promise<void>;
  close(): Promise<void>;
};

/**
 * Boots the application through the real composition root against a throwaway
 * Postgres database and master key file, with a controllable Clock.
 */
export async function bootForTest(options: TestOptions = {}): Promise<TestInstance> {
  const databaseName = `family_butler_test_${randomBytes(6).toString("hex")}`;
  await withServer((client) => client.query(`CREATE DATABASE ${databaseName}`));
  const databaseUrl = new URL(serverUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const keyDirectory = await mkdtemp(join(tmpdir(), "family-butler-test-"));

  const workspacePackages = join(keyDirectory, "packages");
  const pluginDirectory = join(keyDirectory, "plugins");
  await mkdir(workspacePackages);
  await mkdir(pluginDirectory);

  const clock = new FakeClock(new Date("2026-09-14T07:00:00Z"));
  let config: ApplicationConfig = {
    databaseUrl: databaseUrl.toString(),
    masterKeyFile: join(keyDirectory, "master.key"),
    blobDirectory: join(keyDirectory, "blobs"),
    sourcePluginDirectories: [workspacePackages, pluginDirectory],
    applicationVersion: "1.0.0",
    timeZone: "Europe/Berlin",
    clock,
    ...options,
  };

  const instance: TestInstance = {
    app: await bootApplication(config),
    clock,
    masterKeyFile: config.masterKeyFile,
    workspacePackages,
    pluginDirectory,
    async query(sql) {
      const client = new pg.Client({ connectionString: config.databaseUrl });
      await client.connect();
      try {
        return (await client.query<Record<string, unknown>>(sql)).rows;
      } finally {
        await client.end();
      }
    },
    async restart(changes = {}) {
      config = { ...config, ...changes };
      const stopped = instance.app;
      await stopped.close();
      // Already closed, should booting again fail.
      instance.app = { ...stopped, close: () => Promise.resolve() };
      instance.app = await bootApplication(config);
    },
    async close() {
      await instance.app.close();
      await withServer((client) => client.query(`DROP DATABASE ${databaseName} WITH (FORCE)`));
      await rm(keyDirectory, { recursive: true, force: true });
    },
  };
  return instance;
}

async function withServer(run: (client: pg.Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}
