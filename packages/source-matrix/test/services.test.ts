import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@family-agenda/source-sdk";
import { ensureDatabase, matrixServices, type MatrixServicesOptions } from "../src/services";

/** A Postgres server to create Synapse's database on; without one, those tests skip. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

/** Reconciles as the worker does, every few milliseconds here, until `check` holds. */
async function reconcileUntil(services: Services, enabled: { enabled: boolean; entries: string[] }, check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    await services.reconcile(enabled);
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out");
}

describe("Synapse and the bridges, run by the worker", () => {
  let root: string;
  let options: MatrixServicesOptions;
  let services: Services;
  let synapseUrl: string;
  let bridgeUrl: string;
  const lines: string[] = [];
  /** The databases created for Synapse, with the password its role was given. */
  let created: { name: string; user: string; password: string }[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agenda-matrix-"));
    const ports = { synapse: await freePort(), bridges: { whatsapp: await freePort() } };
    synapseUrl = `http://127.0.0.1:${ports.synapse}`;
    bridgeUrl = `http://127.0.0.1:${ports.bridges.whatsapp}`;
    created = [];
    options = {
      programs: { synapse: fixture("fake-synapse.mjs"), bridges: { whatsapp: fixture("fake-bridge.mjs") } },
      databaseUrl: "postgres://family_agenda@postgres:5432/family_agenda",
      ensureDatabase: (database, password) => {
        created.push({ name: database.name, user: database.user, password });
        return Promise.resolve();
      },
      dataDirectory: join(root, "data"),
      instanceFile: join(root, "instance", "instance.json"),
      host: "worker",
      serverName: "family-agenda.local",
      ports,
      database: { host: "postgres", port: 5432, name: "synapse", user: "synapse" },
      log: (line) => lines.push(line),
    };
    services = matrixServices(options);
  });
  afterEach(async () => {
    await services.stop();
    await rm(root, { recursive: true, force: true });
  });

  const whatsapp = { enabled: true, entries: ["whatsapp"] };

  it("runs nothing while no Messenger is enabled", async () => {
    await services.reconcile({ enabled: true, entries: [] });
    await services.reconcile({ enabled: false, entries: ["whatsapp"] });

    expect(await answers(`${synapseUrl}/health`)).toBe(false);
    await expect(readFile(options.instanceFile)).rejects.toThrow();
  });

  it("creates Synapse's database, then starts Synapse and the bridge of an enabled Messenger", async () => {
    await reconcileUntil(services, whatsapp, () => answers(`${bridgeUrl}/_matrix/mau/live`));

    expect(await answers(`${synapseUrl}/health`)).toBe(true);
    const homeserver = await readFile(join(options.dataDirectory, "synapse", "homeserver.yaml"), "utf8");
    expect(created).toEqual([{ name: "synapse", user: "synapse", password: expect.any(String) as string }]);
    expect(homeserver).toContain(`password: "${created[0]!.password}"`);
    const instance = JSON.parse(await readFile(options.instanceFile, "utf8")) as { homeserver: { url: string } };
    expect(instance.homeserver.url).toBe(`http://worker:${options.ports.synapse}`);
    expect(JSON.parse(await readFile(join(root, "instance", "status.json"), "utf8"))).toEqual({ problem: null });
  });

  it("stops them all once the Messenger is disabled", async () => {
    await reconcileUntil(services, whatsapp, () => answers(`${bridgeUrl}/_matrix/mau/live`));

    await services.reconcile({ enabled: true, entries: [] });

    expect(await answers(`${bridgeUrl}/_matrix/mau/live`)).toBe(false);
    expect(await answers(`${synapseUrl}/health`)).toBe(false);
  });

  it("starts a bridge that ended again", async () => {
    await reconcileUntil(services, whatsapp, () => answers(`${bridgeUrl}/_matrix/mau/live`));

    await fetch(`${bridgeUrl}/end`).catch(() => undefined);
    await reconcileUntil(services, whatsapp, async () => !(await answers(`${bridgeUrl}/_matrix/mau/live`)));
    await reconcileUntil(services, whatsapp, () => answers(`${bridgeUrl}/_matrix/mau/live`));

    expect(lines.some((line) => line.startsWith("[mautrix-whatsapp] ended with code 1; starting it again"))).toBe(true);
  });

  it("tells the api container why it cannot set Synapse up", async () => {
    const broken = matrixServices({
      ...options,
      ensureDatabase: () => Promise.reject(new Error('password authentication failed for user "family_agenda"')),
    });

    await expect(broken.reconcile(whatsapp)).rejects.toThrow("Matrix could not be set up:");

    const status = JSON.parse(await readFile(join(root, "instance", "status.json"), "utf8")) as { problem: string };
    expect(status.problem).toBe('Matrix could not be set up: password authentication failed for user "family_agenda"');
    await broken.stop();
  });
});

describe("Synapse's database, on a scripted Postgres client", () => {
  const database = { host: "postgres", port: 5432, name: "synapse", user: "synapse_user" };

  /** Runs ensureDatabase against a client that answers `existing` role/database lookups; returns what it ran. */
  async function run(existing: { role: boolean; database: boolean }): Promise<string[]> {
    const ran: string[] = [];
    const client = {
      connect: () => Promise.resolve(),
      end: () => Promise.resolve(),
      escapeIdentifier: (name: string) => `"${name}"`,
      escapeLiteral: (value: string) => `'${value}'`,
      query: (sql: string) => {
        ran.push(sql);
        const lookup = sql.startsWith("SELECT 1 FROM pg_roles") ? existing.role : sql.startsWith("SELECT 1 FROM pg_database") ? existing.database : false;
        return Promise.resolve({ rowCount: lookup ? 1 : 0 });
      },
    };
    const spy = vi.spyOn(pg, "Client").mockImplementation(function () {
      return client as unknown as pg.Client;
    });
    try {
      await ensureDatabase("postgres://scripted", database, "pw");
    } finally {
      spy.mockRestore();
    }
    return ran.filter((sql) => !sql.startsWith("SELECT"));
  }

  it("creates the role and the database when neither exists", async () => {
    expect(await run({ role: false, database: false })).toEqual([
      `CREATE ROLE "synapse_user" LOGIN PASSWORD 'pw'`,
      `CREATE DATABASE "synapse" OWNER "synapse_user" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
    ]);
  });

  it("only gives an existing role its password again, and keeps an existing database", async () => {
    expect(await run({ role: true, database: true })).toEqual([`ALTER ROLE "synapse_user" LOGIN PASSWORD 'pw'`]);
  });
});

describe.skipIf(!databaseUrl)("Synapse's database, on the Instance's Postgres server", () => {
  const serverUrl = databaseUrl ?? "";
  const name = `synapse_test_${randomBytes(4).toString("hex")}`;
  // Where Synapse would connect; ensureDatabase itself only uses the name and the role.
  const database = { host: "postgres", port: 5432, name, user: name };

  async function query<T extends pg.QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    const client = new pg.Client({ connectionString: serverUrl });
    await client.connect();
    try {
      return (await client.query<T>(sql, values)).rows;
    } finally {
      await client.end();
    }
  }

  afterEach(async () => {
    await query(`DROP DATABASE IF EXISTS ${name}`);
    await query(`DROP ROLE IF EXISTS ${name}`);
  });

  it("is created with the C collation Synapse needs, owned by a role of its own", async () => {
    await ensureDatabase(serverUrl, database, "first");

    expect(
      await query("SELECT datcollate, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1", [name]),
    ).toEqual([{ datcollate: "C", owner: name }]);
    const login = new pg.Client({ connectionString: serverUrl, user: name, password: "first", database: name });
    await login.connect();
    await login.end();
  });

  it("is kept on a later start, which gives the role the password again", async () => {
    await ensureDatabase(serverUrl, database, "first");
    await ensureDatabase(serverUrl, database, "second");

    expect(await query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).toHaveLength(1);
    const login = new pg.Client({ connectionString: serverUrl, user: name, password: "second", database: name });
    await login.connect();
    await login.end();
  });

  it("cannot be created where Postgres does not let the URL in", async () => {
    const wrong = new URL(serverUrl);
    wrong.username = "nobody";
    wrong.password = "wrong";

    await expect(ensureDatabase(wrong.toString(), database, "first")).rejects.toThrow();
  });
});
