import { randomBytes } from "node:crypto";
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

  it("lists the secrets it holds", async () => {
    instance = await boot();
    const { secrets } = instance.app;
    const kept = await secrets.put("hunter2");
    await secrets.remove(await secrets.put("gone"));

    expect((await secrets.list()).map((secret) => secret.ref)).toEqual([kept]);
  });
});

describe("the secret sweep", () => {
  let instance: TestInstance;
  afterEach(async () => {
    await instance.close();
  });

  it("removes the secrets nothing refers to, once they are an hour old", async () => {
    instance = await bootForTest();
    const { secrets, secretSweep, llmEndpoint } = instance.app;
    await llmEndpoint.save({ baseUrl: "https://llm.example.org/v1", model: "large", apiKey: "sk-key", thirdPartiesAcknowledged: true });
    const forgotten = await secrets.put("left behind by a crash");
    const fresh = await secrets.put("about to be referred to");
    // The clock stands at 07:00; all but the fresh one were stored two hours before.
    await instance.query(`UPDATE secret SET created_at = '2026-09-14T05:00:00Z' WHERE id <> '${fresh}'`);

    expect(await secretSweep.sweep()).toBe(1);

    expect(await secrets.get(forgotten)).toBeNull();
    expect(await secrets.get(fresh)).toBe("about to be referred to");
    expect(await llmEndpoint.current()).toMatchObject({ hasApiKey: true });
    expect((await secrets.list()).length).toBe(2);
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
        "SELECT id, encode(wrapped_data_key, 'escape') AS k, encode(ciphertext, 'escape') AS c FROM secret",
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

  it("keeps the master key out of Postgres, and reads secrets again after a restart with it", async () => {
    instance = await bootForTest();
    const ref = await instance.app.secrets.put("hunter2");

    await instance.restart();

    expect(await instance.app.secrets.get(ref)).toBe("hunter2");
    const stored = await storedValues();
    expect(stored).not.toContain(instance.masterKey.toString("hex"));
    expect(stored).not.toContain(instance.masterKey.toString("base64"));
  });

  it("cannot read secrets with another master key", async () => {
    instance = await bootForTest();
    const ref = await instance.app.secrets.put("hunter2");

    await instance.restart(randomBytes(32));

    await expect(instance.app.secrets.get(ref)).rejects.toThrow();
  });
});
