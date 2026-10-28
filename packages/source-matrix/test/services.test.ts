import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Services } from "@family-agenda/source-sdk";
import { matrixServices, type MatrixServicesOptions } from "../src/services";

const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
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
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "family-agenda-matrix-"));
    const name = `synapse_test_${randomBytes(4).toString("hex")}`;
    const ports = { synapse: await freePort(), bridges: { whatsapp: await freePort() } };
    synapseUrl = `http://127.0.0.1:${ports.synapse}`;
    bridgeUrl = `http://127.0.0.1:${ports.bridges.whatsapp}`;
    const database = new URL(databaseUrl);
    options = {
      programs: { synapse: fixture("fake-synapse.mjs"), bridges: { whatsapp: fixture("fake-bridge.mjs") } },
      databaseUrl,
      dataDirectory: join(root, "data"),
      instanceFile: join(root, "instance", "instance.json"),
      host: "worker",
      serverName: "family-agenda.local",
      ports,
      database: { host: database.hostname, port: Number(database.port || 5432), name, user: name },
      log: (line) => lines.push(line),
    };
    services = matrixServices(options);
  });
  afterEach(async () => {
    await services.stop();
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${options.database.name}`);
    await client.query(`DROP ROLE IF EXISTS ${options.database.user}`);
    await client.end();
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
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const { rows } = await client.query<{ datcollate: string; owner: string }>(
      "SELECT datcollate, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
      [options.database.name],
    );
    await client.end();
    expect(rows).toEqual([{ datcollate: "C", owner: options.database.user }]);
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
    const broken = matrixServices({ ...options, databaseUrl: `postgres://nobody:wrong@127.0.0.1:${await freePort()}/postgres` });

    await expect(broken.reconcile(whatsapp)).rejects.toThrow("Matrix could not be set up:");

    const status = JSON.parse(await readFile(join(root, "instance", "status.json"), "utf8")) as { problem: string };
    expect(status.problem).toMatch(/^Matrix could not be set up: /);
    await broken.stop();
  });
});
