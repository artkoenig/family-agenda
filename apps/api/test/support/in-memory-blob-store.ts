import { randomUUID } from "node:crypto";
import type { BlobStore } from "@family-agenda/application";
import type { BlobRef } from "@family-agenda/domain";

/** Keeps blobs in memory, for use cases that do not care where files are kept. */
export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<BlobRef, Uint8Array<ArrayBuffer>>();

  /** How many blobs it holds, to see that none are left behind. */
  get size(): number {
    return this.blobs.size;
  }

  put(contents: Uint8Array): Promise<BlobRef> {
    const ref = randomUUID() as BlobRef;
    this.blobs.set(ref, new Uint8Array(contents));
    return Promise.resolve(ref);
  }

  get(ref: BlobRef): Promise<Uint8Array<ArrayBuffer> | null> {
    const blob = this.blobs.get(ref);
    return Promise.resolve(blob ? new Uint8Array(blob) : null);
  }

  remove(ref: BlobRef): Promise<void> {
    this.blobs.delete(ref);
    return Promise.resolve();
  }
}
