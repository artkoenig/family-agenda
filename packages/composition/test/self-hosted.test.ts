import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootSelfHosted, bootSelfHostedWorker, readFamilyDatabase, readSharedWorkerConfig, selfHostedAdapters, workerFrom } from "../src/self-hosted";

describe("the adapters of a self-hosted Instance", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-agenda-self-hosted-"));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("link the bundled OCR models into the volume and reach the Plugin Host", async () => {
    const bundled = join(directory, "bundled");
    await mkdir(bundled);
    await writeFile(join(bundled, "deu.traineddata"), "deu");
    const masterKey = randomBytes(32);

    const adapters = await selfHostedAdapters({
      databaseUrl: "postgres://unused/family",
      masterKey,
      blobDirectory: join(directory, "blobs"),
      tessdataDirectory: join(directory, "tessdata"),
      bundledTessdataDirectory: bundled,
      pluginHost: { url: "http://plugin-host:4100", token: "t" },
    });

    expect(adapters.masterKey).toBe(masterKey);
    expect(adapters.pluginHost).toEqual({ url: "http://plugin-host:4100", token: "t" });
    expect(await readdir(join(directory, "tessdata"))).toEqual(["deu.traineddata"]);
    await adapters.postgres.close();
  });
});

describe("booting from the environment", () => {
  it("fails at start without a time zone", async () => {
    await expect(bootSelfHosted({ DATABASE_URL: "postgres://unused/family", MASTER_KEY: randomBytes(32).toString("base64") })).rejects.toThrow(/TZ is not set/);
  });

  it("fails at start without a master key, before it touches Postgres", async () => {
    await expect(readFamilyDatabase({ TZ: "Europe/Berlin", DATABASE_URL: "postgres://unused/family" })).rejects.toThrow(/master key is not set/);
  });
});

describe("the worker shared by Families", () => {
  const pluginHost = { PLUGIN_HOST_URL: "http://plugin-host:4100", PLUGIN_HOST_TOKEN: "t" };

  it("needs no database, master key or time zone of its own", async () => {
    expect(readSharedWorkerConfig({ ...pluginHost, TESSDATA_DIRECTORY: "/t", BUNDLED_TESSDATA_DIRECTORY: "", PLUGIN_TIMEOUT_SECONDS: "5" })).toEqual({
      tessdataDirectory: "/t",
      bundledTessdataDirectory: null,
      pluginHost: { url: "http://plugin-host:4100", token: "t" },
      pluginTimeoutMs: 5000,
    });
    expect(readSharedWorkerConfig(pluginHost).pluginTimeoutMs).toBeUndefined();
    const service = bootSelfHostedWorker(pluginHost);
    await service.close();
  });

  it("boots a Family from the database its trigger names, and fails for one it cannot reach", async () => {
    const service = bootSelfHostedWorker({ ...pluginHost, TESSDATA_DIRECTORY: join(tmpdir(), "family-agenda-tessdata"), BUNDLED_TESSDATA_DIRECTORY: "", PLUGIN_TIMEOUT_SECONDS: "5" });
    const family = { databaseUrl: "postgres://nobody@127.0.0.1:1/none", masterKey: randomBytes(32), blobDirectory: join(tmpdir(), "family-agenda-blobs"), timeZone: "Europe/Berlin" };

    await expect(service.poll(family)).rejects.toThrow();
    await service.close();
  });

  it("is triggered by api with the Family's database and the worker's address", async () => {
    const masterKey = randomBytes(32);
    expect(await readFamilyDatabase({ TZ: "Asia/Tokyo", DATABASE_URL: "postgres://db/f", MASTER_KEY: masterKey.toString("base64"), BLOB_DIRECTORY: "/b", ...pluginHost })).toEqual({
      databaseUrl: "postgres://db/f",
      masterKey,
      blobDirectory: "/b",
      timeZone: "Asia/Tokyo",
    });
    expect(workerFrom({ WORKER_URL: "http://worker:4200", WORKER_TOKEN: "w" })).toEqual({ url: "http://worker:4200", token: "w" });
    expect(() => workerFrom({ WORKER_TOKEN: "w" })).toThrow(/WORKER_URL is not set/);
    expect(() => workerFrom({ WORKER_URL: "http://worker:4200" })).toThrow(/WORKER_TOKEN is not set/);
  });
});
