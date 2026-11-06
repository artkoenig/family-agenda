export type ItemId = string & { readonly __brand: "ItemId" };

export type OriginId = string & { readonly __brand: "OriginId" };

/** A message, such as a mail, kept with its attachments for extraction (ADR-0006). */
export type RawMessageId = string & { readonly __brand: "RawMessageId" };

/** The kinds of Item (ADR-0016): each comes from exactly one Source Record. */
export const itemKinds = ["event", "task", "lesson"] as const;

export type ItemKind = (typeof itemKinds)[number];

/** The kinds of Item a calendar or timetable Source states on its Source Record (ADR-0016). */
export const statedItemKinds = ["event", "lesson", "task"] as const satisfies readonly ItemKind[];

/**
 * An Item as JSON fields, the way a plugin or extraction states them, before its kind gives the
 * fields a meaning; `cancelled` is whether it was called off.
 */
export type ItemFields = {
  fields: Record<string, unknown>;
  cancelled: boolean;
};
