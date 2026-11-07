import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootSelfHosted, bootSelfHostedWorker, selfHostedAdapters } from "../src/self-hosted";

describe("the adapters of a self-hosted Instance", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-agenda-self-hosted-"));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("link the bundled OCR models into the volume and look for plugins in the shipped packages, then the volume", async () => {
    const bundled = join(directory, "bundled");
    await mkdir(bundled);
    await writeFile(join(bundled, "deu.traineddata"), "deu");
    const masterKey = randomBytes(32);

    const adapters = await selfHostedAdapters({
      databaseUrl: "postgres://unused/family",
      masterKey,
      blobDirectory: join(directory, "blobs"),
      pluginDirectory: join(directory, "plugins"),
      tessdataDirectory: join(directory, "tessdata"),
      bundledTessdataDirectory: bundled,
      workspacePackages: join(directory, "packages"),
    });

    expect(adapters.masterKey).toBe(masterKey);
    expect(adapters.pluginDirectories).toEqual([join(directory, "packages"), join(directory, "plugins")]);
    expect(await readdir(join(directory, "tessdata"))).toEqual(["deu.traineddata"]);
    await adapters.postgres.close();
  });
});

describe("booting from the environment", () => {
  it("fails at start without a time zone", async () => {
    await expect(bootSelfHosted({ DATABASE_URL: "postgres://unused/family", MASTER_KEY: randomBytes(32).toString("base64") })).rejects.toThrow(/TZ is not set/);
  });

  it("fails at start without a master key, before it touches Postgres", async () => {
    await expect(bootSelfHostedWorker({ TZ: "Europe/Berlin", DATABASE_URL: "postgres://unused/family" })).rejects.toThrow(/master key is not set/);
  });
});
