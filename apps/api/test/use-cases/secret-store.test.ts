import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { SecretRef } from "@family-agenda/application";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemorySecretStore } from "../support/in-memory-secret-store";

describe.each([
  { store: "envelope encryption", boot: () => bootForTest() },
  { store: "the in-memory fake", boot: () => bootForTest({ secretStore: new InMemorySecretStore() }) },
])("SecretStore with $store", ({ boot }) => {
  let instance: TestInstance;
  afterEach(async () => {
    await instance.close();
  });

  it("gives a stored secret back by its reference", async () => {
    instance = await boot();
    const { secrets } = instance.app;

    const ref = await secrets.put("imap password: hunter2 ✓");

    expect(await secrets.get(ref)).toBe("imap password: hunter2 ✓");
  });

  it("knows no secret after removing it, nor one it never stored", async () => {
    instance = await boot();
    const { secrets } = instance.app;
    const ref = await secrets.put("hunter2");

    await secrets.remove(ref);

    expect(await secrets.get(ref)).toBeNull();
    expect(await secrets.get("not-a-reference" as SecretRef)).toBeNull();
  });
});

describe("secrets at rest", () => {
  let instance: TestInstance;
  afterEach(async () => {
    await instance.close();
  });

  // Bytes as text, printable ones unchanged, so that plaintext would show up as such.
  const storedValues = async () =>
    JSON.stringify(
      await instance.query(
        "SELECT id, encode(wrapped_data_key, 'escape') AS k, encode(ciphertext, 'escape') AS c FROM secrets",
      ),
    );

  it("never stores the plaintext in Postgres", async () => {
    instance = await bootForTest();
    await instance.app.secrets.put("ics-url-secret-0123456789");

    const stored = await storedValues();

    expect(stored).not.toContain("ics-url-secret-0123456789");
    expect(stored).not.toContain(Buffer.from("ics-url-secret-0123456789").toString("hex"));
    expect(stored).not.toContain(Buffer.from("ics-url-secret-0123456789").toString("base64"));
  });

  it("keeps the master key in its own file, created on first start and kept across restarts", async () => {
    instance = await bootForTest();
    const ref = await instance.app.secrets.put("hunter2");
    const masterKey = await readFile(instance.masterKeyFile);
    expect(masterKey).toHaveLength(32);

    await instance.restart();

    expect(await readFile(instance.masterKeyFile)).toEqual(masterKey);
    expect(await instance.app.secrets.get(ref)).toBe("hunter2");
    const stored = await storedValues();
    expect(stored).not.toContain(masterKey.toString("hex"));
    expect(stored).not.toContain(masterKey.toString("base64"));
  });

  it("refuses to start without the master key file once secrets are stored", async () => {
    instance = await bootForTest();
    await instance.app.secrets.put("hunter2");

    await rm(instance.masterKeyFile);

    await expect(instance.restart()).rejects.toThrow(/master key file .* is missing/);
    await expect(readFile(instance.masterKeyFile)).rejects.toThrow(/ENOENT/);
  });

  it("cannot read secrets with another master key", async () => {
    instance = await bootForTest();
    const ref = await instance.app.secrets.put("hunter2");

    await writeFile(instance.masterKeyFile, randomBytes(32));
    await instance.restart();

    await expect(instance.app.secrets.get(ref)).rejects.toThrow();
  });
});
