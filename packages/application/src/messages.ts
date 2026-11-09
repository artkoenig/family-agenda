import type { ItemId, RawMessageId } from "@family-agenda/domain";
import type { BlobStore, ItemRepository, ProjectedItem } from "./ports";

export type MessageDetails = {
  id: RawMessageId;
  sentAt: Date;
  sender: string | null;
  subject: string | null;
  /** The names of the Source Attributes it belongs to, such as a mail folder. */
  attributes: string[];
  text: string;
  /** When its content was deleted; null while it is kept. The Admin area then says it is no longer kept. */
  purgedAt: Date | null;
  /** Each with its place among the attachments, and why it could not be turned into text for extraction, or null. */
  attachments: { position: number; filename: string; contentType: string; size: number; conversionProblem: string | null }[];
  /** The Items written from it, which an Admin can delete. */
  items: ProjectedItem[];
};

/** Raw messages, as an Admin opens them to check what a Source actually said, and their Items. */
export function createMessageAccess(deps: { items: ItemRepository; blobs: BlobStore }) {
  const { items, blobs } = deps;
  return {
    async open(id: RawMessageId): Promise<MessageDetails | null> {
      const message = await items.findMessage(id);
      if (!message) return null;
      return {
        id: message.id,
        sentAt: message.sentAt,
        sender: message.sender,
        subject: message.subject,
        attributes: message.attributes,
        text: message.body,
        purgedAt: message.purgedAt,
        attachments: message.attachments.map(({ position, filename, contentType, size, conversionProblem }) => ({
          position,
          filename,
          contentType,
          size,
          conversionProblem,
        })),
        items: await items.itemsOfMessage(id),
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

    /** Deletes an Item, as an Admin's only correction (ADR-0005); nothing remembers it. Returns whether there was one. */
    deleteItem(id: ItemId): Promise<boolean> {
      return items.remove(id);
    },
  };
}

export type MessageAccess = ReturnType<typeof createMessageAccess>;
