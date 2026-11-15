import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore } from "@family-agenda/application";
import type { BlobRef } from "@family-agenda/domain";
import { uuidPattern } from "./uuid";

/**
 * Keeps each blob of one Family as a file named by its reference, in a folder named by the
 * Family id inside the blob volume: `<blob directory>/<family id>/<blob reference>` (ADR-0003).
 */
export class FileBlobStore implements BlobStore {
  private readonly folder: string;

  constructor(
    private readonly directory: string,
    familyId: string,
  ) {
    this.folder = join(directory, familyId);
  }

  async put(contents: Uint8Array): Promise<BlobRef> {
    const ref = randomUUID();
    await mkdir(this.folder, { recursive: true });
    // Written in place, without a draft and a rename: the reference is random and handed out only
    // once the write is done, so nothing can ask for the blob while it is still half-written.
    await writeFile(join(this.folder, ref), contents, { mode: 0o600 });
    return ref as BlobRef;
  }

  async get(ref: BlobRef): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!uuidPattern.test(ref)) return null;
    try {
      return new Uint8Array(await readFile(join(this.folder, ref)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async remove(ref: BlobRef): Promise<void> {
    if (!uuidPattern.test(ref)) return;
    await rm(join(this.folder, ref), { force: true });
  }

  /**
   * Moves the blobs of the layout before Family folders, files named by a blob reference in the
   * top level of the blob directory, into the Family's folder. Folders and other files stay where
   * they are. Running it again finishes a move that was interrupted, and otherwise changes nothing.
   */
  async adoptTopLevelBlobs(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const blobs = entries.filter((entry) => entry.isFile() && uuidPattern.test(entry.name));
    if (blobs.length === 0) return;
    await mkdir(this.folder, { recursive: true });
    for (const blob of blobs) await rename(join(this.directory, blob.name), join(this.folder, blob.name));
  }
}
