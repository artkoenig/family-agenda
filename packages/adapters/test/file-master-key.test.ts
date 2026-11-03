import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMasterKey, masterKeyLength, readMasterKey } from "../src";

/** Lets a test make `link` fail or do nothing; otherwise it links. */
const linking = vi.hoisted((): { behaviour: "link" | "do-nothing" | Error } => ({ behaviour: "link" }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      if (linking.behaviour instanceof Error) throw linking.behaviour;
      if (linking.behaviour === "link") await actual.link(from, to);
    },
  };
});

describe("the master key file", () => {
  let directory: string;
  let path: string;
  beforeEach(async () => {
    linking.behaviour = "link";
    directory = await mkdtemp(join(tmpdir(), "family-agenda-key-"));
    path = join(directory, "keys", "master.key");
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("is created once, with a key of the right length, and read back", async () => {
    const key = await createMasterKey(path);

    expect(key).toHaveLength(masterKeyLength);
    expect(await readMasterKey(path)).toEqual(key);
    expect(await readdir(join(directory, "keys"))).toEqual(["master.key"]);
  });

  it("is the key another process created first", async () => {
    const [first, second] = await Promise.all([createMasterKey(path), createMasterKey(path)]);

    expect(second).toEqual(first);
  });

  it("is missing until created, and refused when of the wrong length", async () => {
    expect(await readMasterKey(path)).toBeNull();
    await createMasterKey(path);
    await writeFile(path, "short");

    await expect(readMasterKey(path)).rejects.toThrow("does not hold a 32-byte key");
  });

  it("fails when it cannot be read for another reason", async () => {
    await expect(readMasterKey(directory)).rejects.toThrow();
  });

  it("fails when the file cannot be linked into place, leaving no draft behind", async () => {
    linking.behaviour = Object.assign(new Error("no space left"), { code: "ENOSPC" });

    await expect(createMasterKey(path)).rejects.toThrow("no space left");
    expect(await readdir(join(directory, "keys"))).toEqual([]);
  });

  it("fails when the file vanished after it was created", async () => {
    linking.behaviour = "do-nothing";

    await expect(createMasterKey(path)).rejects.toThrow("vanished after creating it");
  });
});
