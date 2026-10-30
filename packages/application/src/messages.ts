import type { RawMessageId } from "@family-agenda/domain";
import type { BlobStore, ItemRepository } from "./ports";

export type MessageDetails = {
  id: RawMessageId;
  sentAt: Date;
  /** The Origin attributes of the message, such as its sender. */
  attributes: Record<string, string>;
  /** Null once retention has deleted it. */
  text: string | null;
  /** Each with its place among the attachments, and why it could not be turned into text for extraction, or null. */
  attachments: { position: number; filename: string; contentType: string; size: number; conversionProblem: string | null }[];
};

/** Raw messages, as an Admin opens them to check what a Source actually said. */
export function createMessageAccess(deps: { items: ItemRepository; blobs: BlobStore }) {
  const { items, blobs } = deps;
  return {
    async open(id: RawMessageId): Promise<MessageDetails | null> {
      const message = await items.findMessage(id);
      if (!message) return null;
      const bytes = await blobs.get(message.text);
      return {
        id: message.id,
        sentAt: message.sentAt,
        attributes: message.attributes,
        text: bytes ? new TextDecoder().decode(bytes) : null,
        attachments: message.attachments.map(({ position, filename, contentType, size, conversionProblem }) => ({
          position,
          filename,
          contentType,
          size,
          conversionProblem,
        })),
      };
    },

    /** An attachment as the Source delivered it, for an Admin to download; null if it is gone. */
    async attachment(
      id: RawMessageId,
      position: number,
    ): Promise<{ filename: string; contentType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
      const message = await items.findMessage(id);
      const attachment = message?.attachments.find((candidate) => candidate.position === position);
      if (!attachment) return null;
      const bytes = await blobs.get(attachment.blob);
      return bytes && { filename: attachment.filename, contentType: attachment.contentType, bytes };
    },
  };
}

export type MessageAccess = ReturnType<typeof createMessageAccess>;
