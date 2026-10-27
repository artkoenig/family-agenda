import type { RawMessageId } from "@family-butler/domain";
import type { BlobStore, ItemRepository } from "./ports";

export type MessageDetails = {
  id: RawMessageId;
  sentAt: Date;
  /** The Origin attributes of the message, such as its sender. */
  attributes: Record<string, string>;
  /** Null once retention has deleted it. */
  text: string | null;
  /** Each with why it could not be turned into text for extraction, or null. */
  attachments: { filename: string; contentType: string; size: number; conversionProblem: string | null }[];
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
        attachments: message.attachments.map(({ filename, contentType, size, conversionProblem }) => ({
          filename,
          contentType,
          size,
          conversionProblem,
        })),
      };
    },
  };
}

export type MessageAccess = ReturnType<typeof createMessageAccess>;
