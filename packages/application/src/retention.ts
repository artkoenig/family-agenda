import type { BlobStore, Clock, ItemRepository } from "./ports";

/** How long a message is kept at most, counted from when its Source received it. Not a Family setting. */
export const messageRetentionDays = 180;

const dayMs = 24 * 60 * 60 * 1000;

/** The time before which a message is past retention, at `now`. */
export const retainedSince = (now: Date): Date => new Date(now.getTime() - messageRetentionDays * dayMs);

/**
 * Deletes the text and attachments of messages after their retention (ADR-0016): once no Item
 * needs them, or when they are older than the retention period, whichever comes first. The
 * Source Record stays as a tombstone, and its row goes once no Item points to it and it is that old.
 */
export function createRetention(deps: { clock: Clock; items: ItemRepository; blobs: BlobStore }) {
  const { clock, items, blobs } = deps;
  return {
    /** Returns how many messages it purged and how many rows it deleted. */
    async purge(): Promise<{ purged: number; deleted: number }> {
      const now = clock.now();
      const { files, purged, deleted } = await items.purgeMessages(now, retainedSince(now));
      // After the commit; a file that stays behind is caught by the sweep.
      for (const file of files) await blobs.remove(file);
      return { purged, deleted };
    },
  };
}

export type Retention = ReturnType<typeof createRetention>;
