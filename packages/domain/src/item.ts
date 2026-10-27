export type ItemId = string & { readonly __brand: "ItemId" };

export type OriginId = string & { readonly __brand: "OriginId" };

export type ItemKind = "event" | "lesson" | "timetable-change" | "task" | "notice";

/** What a Revision states about its Item (ADR-0009). */
export type Act = "create" | "change" | "move" | "cancel";

/** One statement about an Item, appended and never changed except for being rejected or restored. */
export type Revision = {
  itemKind: ItemKind;
  act: Act;
  /** The fields the Revision states, by name, as their Item kind defines them. */
  fields: Record<string, unknown>;
  /** When the Source said it, such as a calendar entry's `LAST-MODIFIED`. */
  sourceTime: Date;
  /** Who said it: an Origin; Admins come later. */
  author: { kind: "origin"; originId: OriginId };
  accepted: boolean;
};

/** An Item as its accepted Revisions add up to, before its kind gives the fields a meaning. */
export type FoldedItem = { fields: Record<string, unknown>; cancelled: boolean };

export type FoldableRevision = Pick<Revision, "act" | "fields" | "sourceTime" | "accepted"> & {
  /** The order the Revision was received in, which decides between equal source times. */
  sequence: number;
};

/**
 * Applies the accepted Revisions field by field in source-time order, so that the newest wins,
 * whatever order they arrived in. A cancel marks the Item cancelled and a create restores it.
 * Null when no accepted Revision is left, or when the first Revision received was rejected: that
 * removes the Item, and later Revisions stay with it without bringing it back.
 */
export function fold(revisions: readonly FoldableRevision[]): FoldedItem | null {
  const first = revisions.reduce<FoldableRevision | undefined>(
    (earliest, revision) => (earliest && earliest.sequence <= revision.sequence ? earliest : revision),
    undefined,
  );
  if (!first?.accepted) return null;
  const accepted = revisions
    .filter((revision) => revision.accepted)
    .sort((a, b) => a.sourceTime.getTime() - b.sourceTime.getTime() || a.sequence - b.sequence);
  if (accepted.length === 0) return null;
  const folded: FoldedItem = { fields: {}, cancelled: false };
  for (const revision of accepted) {
    Object.assign(folded.fields, revision.fields);
    if (revision.act === "cancel") folded.cancelled = true;
    if (revision.act === "create") folded.cancelled = false;
  }
  return folded;
}

