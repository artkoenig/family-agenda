export type ItemId = string & { readonly __brand: "ItemId" };

export type OriginId = string & { readonly __brand: "OriginId" };

/** A message, such as a mail, kept with its attachments for extraction (ADR-0006). */
export type RawMessageId = string & { readonly __brand: "RawMessageId" };

/** The kinds of Item (ADR-0016): each comes from exactly one Source Record. */
export const itemKinds = ["event", "task", "lesson"] as const;

export type ItemKind = (typeof itemKinds)[number];

/**
 * What a calendar or timetable plugin still states about an entry, until it states the whole Item
 * on its Source Record (#137): the core applies these to the Item of the entry's Source Record.
 */
export const acts = ["create", "change", "move", "cancel"] as const;

export type Act = (typeof acts)[number];

/**
 * An Item as JSON fields, the way a plugin states them, before its kind gives the fields a
 * meaning; `cancelled` is whether it was called off.
 */
export type ItemFields = {
  fields: Record<string, unknown>;
  cancelled: boolean;
};
