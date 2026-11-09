import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore } from "@family-agenda/application";
import type { BlobRef } from "@family-agenda/domain";
import { uuidPattern } from "./uuid";

/** Keeps each blob as a file named by its reference, in the blob volume (ADR-0003). */
export class FileBlobStore implements BlobStore {
  constructor(private readonly directory: string) {}

  async put(contents: Uint8Array): Promise<BlobRef> {
    const ref = randomUUID();
    await mkdir(this.directory, { recursive: true });
    // Renamed into place, so that a reader never sees a half-written file.
    const draft = join(this.directory, `${ref}.draft`);
    await writeFile(draft, contents, { mode: 0o600 });
    await rename(draft, join(this.directory, ref));
    return ref as BlobRef;
  }

  async get(ref: BlobRef): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!uuidPattern.test(ref)) return null;
    try {
      return new Uint8Array(await readFile(join(this.directory, ref)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async remove(ref: BlobRef): Promise<void> {
    if (!uuidPattern.test(ref)) return;
    await rm(join(this.directory, ref), { force: true });
  }
}
