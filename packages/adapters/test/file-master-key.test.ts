import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { masterKeyLength, readMasterKey } from "../src";

describe("the master key file", () => {
  let directory: string;
  let path: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-agenda-key-"));
    path = join(directory, "master.key");
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("is read back as written", async () => {
    const key = Buffer.alloc(masterKeyLength, 3);
    await writeFile(path, key);
    expect(await readMasterKey(path)).toEqual(key);
  });

  it("is absent, not an error, when there is no file", async () => {
    expect(await readMasterKey(path)).toBeNull();
  });

  it("is refused when it does not hold a 32-byte key", async () => {
    await writeFile(path, "too short");
    await expect(readMasterKey(path)).rejects.toThrow("does not hold a 32-byte key");
  });

  it("fails for a file that cannot be read", async () => {
    await expect(readMasterKey(directory)).rejects.toThrow();
  });
});
