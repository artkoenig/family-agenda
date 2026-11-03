import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobRef } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileBlobStore } from "../src";

describe("the blob volume", () => {
  let directory: string;
  let store: FileBlobStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-agenda-blobs-"));
    store = new FileBlobStore(directory);
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("keeps a blob under its reference, and gives it back", async () => {
    const ref = await store.put(new Uint8Array([1, 2, 3]));

    expect(await store.get(ref)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await readdir(directory)).toEqual([ref]);
  });

  it("has no blob for a reference that is unknown or not one", async () => {
    expect(await store.get("00000000-0000-4000-8000-000000000000" as BlobRef)).toBeNull();
    expect(await store.get("../etc/passwd" as BlobRef)).toBeNull();
  });

  it("fails on a blob it cannot read for another reason", async () => {
    const ref = await store.put(new Uint8Array([1]));
    await rm(join(directory, ref));
    // A directory under the reference's name cannot be read as a file.
    await mkdir(join(directory, ref));

    await expect(store.get(ref)).rejects.toThrow();
  });

  it("removes a blob, and ignores a reference that is not one", async () => {
    const ref = await store.put(new Uint8Array([1]));

    await store.remove(ref);
    await store.remove("../outside" as BlobRef);

    expect(await store.get(ref)).toBeNull();
  });
});
