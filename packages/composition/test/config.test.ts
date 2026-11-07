import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertTimeZone, readApplicationConfig } from "../src/config";
import { readMasterKeyFrom, readSelfHostedConfig } from "../src/self-hosted";

describe("the behaviour of an Instance", () => {
  it("takes the time zone from TZ", () => {
    expect(readApplicationConfig({ TZ: "Europe/Berlin" })).toEqual({ timeZone: "Europe/Berlin" });
  });

  it("fails at start without a time zone, rather than using the one of the process", () => {
    expect(() => readApplicationConfig({})).toThrow(/TZ is not set/);
  });

  it("refuses a name that is no IANA time zone", () => {
    expect(() => { assertTimeZone("Mars/Olympus"); }).toThrow(/not an IANA time zone/);
    expect(() => { assertTimeZone(""); }).toThrow(/not set/);
    assertTimeZone("Europe/Berlin");
  });
});

describe("the master key of a self-hosted Instance", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-agenda-config-"));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("comes from MASTER_KEY in base64", async () => {
    const key = randomBytes(32);
    expect(await readMasterKeyFrom({ MASTER_KEY: key.toString("base64") })).toEqual(key);
  });

  it("refuses a MASTER_KEY of the wrong length", async () => {
    await expect(readMasterKeyFrom({ MASTER_KEY: "c2hvcnQ=" })).rejects.toThrow(/32-byte key in base64/);
  });

  it("comes from an existing key file when MASTER_KEY is unset or empty", async () => {
    const key = randomBytes(32);
    const file = join(directory, "master.key");
    await writeFile(file, key);
    expect(await readMasterKeyFrom({ MASTER_KEY_FILE: file })).toEqual(key);
    expect(await readMasterKeyFrom({ MASTER_KEY: "", MASTER_KEY_FILE: file })).toEqual(key);
  });

  it("is never created: no key, no start", async () => {
    const file = join(directory, "master.key");
    await expect(readMasterKeyFrom({})).rejects.toThrow(/master key is not set/);
    await expect(readMasterKeyFrom({ MASTER_KEY_FILE: file })).rejects.toThrow(/existing key file/);
    await expect(readSelfHostedConfig({ DATABASE_URL: "postgres://x", MASTER_KEY_FILE: file })).rejects.toThrow(/master key is not set/);
  });

  it("needs a database", async () => {
    await expect(readSelfHostedConfig({ MASTER_KEY: randomBytes(32).toString("base64") })).rejects.toThrow(/DATABASE_URL is not set/);
  });

  it("reads the volumes with the image's defaults", async () => {
    const key = randomBytes(32);
    const config = await readSelfHostedConfig({ DATABASE_URL: "postgres://x", MASTER_KEY: key.toString("base64") });
    expect(config).toMatchObject({
      databaseUrl: "postgres://x",
      masterKey: key,
      blobDirectory: "/var/lib/family-agenda/blobs",
      bundledTessdataDirectory: "/usr/share/tesseract-ocr/5/tessdata",
    });
  });
});
