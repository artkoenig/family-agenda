import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instanceReader } from "../src/instance";

describe("the Instance's Matrix setup file", () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-agenda-instance-"));
    file = join(directory, "instance.json");
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  const homeserver = { url: "http://synapse:8008", serverName: "family-agenda.local", registrationSharedSecret: "secret" };

  it("is read with its bridges, leaving out those without an address or secret", async () => {
    await writeFile(
      file,
      JSON.stringify({
        homeserver,
        bridges: { whatsapp: { url: "http://wa:29318", provisioningSecret: "s" }, broken: { url: "http://x" }, empty: {} },
      }),
    );

    expect(await instanceReader(file)()).toEqual({ homeserver, bridges: { whatsapp: { url: "http://wa:29318", provisioningSecret: "s" } } });
  });

  it("has no bridges when the file names none", async () => {
    await writeFile(file, JSON.stringify({ homeserver }));

    expect(await instanceReader(file)()).toEqual({ homeserver, bridges: {} });
  });

  it("is missing until the worker has written a complete homeserver", async () => {
    expect(await instanceReader(file)()).toBeNull();
    for (const incomplete of [null, {}, { homeserver: { url: "http://synapse:8008" } }, { homeserver: { ...homeserver, registrationSharedSecret: 1 } }]) {
      await writeFile(file, JSON.stringify(incomplete));
      expect(await instanceReader(file)()).toBeNull();
    }
  });

  it("fails when the file cannot be read for another reason", async () => {
    await expect(instanceReader(directory)()).rejects.toThrow();
  });

  it("is given as it is when not a file", async () => {
    const given = { homeserver, bridges: {} };

    expect(await instanceReader(given)()).toBe(given);
  });
});
