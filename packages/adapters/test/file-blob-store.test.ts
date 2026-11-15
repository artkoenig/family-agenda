import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobRef } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileBlobStore, parseFamilyId, type FamilyId } from "../src";

const familyIdOf = (value: string): FamilyId =>
  parseFamilyId(value) ??
  (() => {
    throw new Error(`no Family id: ${value}`);
  })();

const familyId = familyIdOf("0b6f3c1e-8a2d-4f5b-9c7e-1d2a3b4c5d6e");
const otherFamilyId = familyIdOf("7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f");
const looseRef = "11111111-2222-4333-8444-555555555555" as BlobRef;

describe("the blob volume", () => {
  let directory: string;
  let store: FileBlobStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-agenda-blobs-"));
    store = new FileBlobStore(directory, familyId);
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it("keeps a blob under its reference in the Family's folder, written in place, and gives it back", async () => {
    const ref = await store.put(new Uint8Array([1, 2, 3]));

    expect(await store.get(ref)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await readdir(directory)).toEqual([familyId]);
    expect(await readdir(join(directory, familyId))).toEqual([ref]);
  });

  it.skipIf(process.platform === "win32")(
    "keeps the Family's folder to its owner",
    async () => {
      await store.put(new Uint8Array([1]));

      expect((await stat(join(directory, familyId))).mode & 0o777).toBe(0o700);
    },
  );

  it("keeps the blobs of two Families on one directory apart", async () => {
    const other = new FileBlobStore(directory, otherFamilyId);
    const ref = await store.put(new Uint8Array([1]));
    const otherRef = await other.put(new Uint8Array([2]));

    expect(await other.get(ref)).toBeNull();
    expect(await store.get(otherRef)).toBeNull();
    await other.remove(ref);
    expect(await store.get(ref)).toEqual(new Uint8Array([1]));
  });

  it("has no blob for a reference that is unknown or not one", async () => {
    expect(
      await store.get("00000000-0000-4000-8000-000000000000" as BlobRef),
    ).toBeNull();
    expect(await store.get("../etc/passwd" as BlobRef)).toBeNull();
  });

  it("fails on a blob it cannot read for another reason", async () => {
    const ref = await store.put(new Uint8Array([1]));
    await rm(join(directory, familyId, ref));
    // A directory under the reference's name cannot be read as a file.
    await mkdir(join(directory, familyId, ref));

    await expect(store.get(ref)).rejects.toThrow();
  });

  it("removes a blob, and ignores a reference that is not one", async () => {
    const ref = await store.put(new Uint8Array([1]));
    await writeFile(join(directory, "outside"), "kept");

    await store.remove(ref);
    await store.remove("../outside" as BlobRef);

    expect(await store.get(ref)).toBeNull();
    expect((await readdir(directory)).sort()).toEqual(
      [familyId, "outside"].sort(),
    );
  });

  describe("moving the blobs of the layout before Family folders", () => {
    it("finds a top-level blob in the Family's folder after the move, and leaves folders and other files", async () => {
      await writeFile(join(directory, looseRef), new Uint8Array([7]));
      await writeFile(join(directory, "notes.txt"), "kept");
      await mkdir(join(directory, "22222222-3333-4444-8555-666666666666"));

      expect(await store.get(looseRef)).toBeNull();
      await store.adoptTopLevelBlobs();

      expect(await store.get(looseRef)).toEqual(new Uint8Array([7]));
      expect((await readdir(directory)).sort()).toEqual(
        [familyId, "22222222-3333-4444-8555-666666666666", "notes.txt"].sort(),
      );
    });

    it("skips a blob another start moved first", async () => {
      const refs = [
        "11111111-2222-4333-8444-000000000001",
        "11111111-2222-4333-8444-000000000002",
        "11111111-2222-4333-8444-000000000003",
      ];
      for (const ref of refs) await writeFile(join(directory, ref), ref);

      await Promise.all([
        store.adoptTopLevelBlobs(),
        new FileBlobStore(directory, familyId).adoptTopLevelBlobs(),
      ]);

      expect((await readdir(join(directory, familyId))).sort()).toEqual(refs);
    });

    it("changes nothing when run twice", async () => {
      await writeFile(join(directory, looseRef), new Uint8Array([7]));

      await store.adoptTopLevelBlobs();
      await store.adoptTopLevelBlobs();

      expect(await readdir(directory)).toEqual([familyId]);
      expect(await readdir(join(directory, familyId))).toEqual([looseRef]);
    });

    it("has nothing to move in a blob directory that does not exist yet, nor creates one", async () => {
      const missing = new FileBlobStore(join(directory, "missing"), familyId);

      await missing.adoptTopLevelBlobs();

      expect(await readdir(directory)).toEqual([]);
    });
  });
});
