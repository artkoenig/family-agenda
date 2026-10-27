import {
  eventOf,
  fold,
  problemsWithEventRevision,
  spanBounds,
  type FoldableRevision,
  type ItemKind,
} from "@family-butler/domain";
import type { IngestedRevision, ItemProjection, NewRevision } from "./ports";

/**
 * A Revision as it is appended: rejected automatically if its fields cannot apply. Only Events
 * have their fields defined yet; the other kinds come with their own tickets.
 */
export function checked(revision: IngestedRevision, sourceTime: Date): NewRevision {
  const accepted =
    revision.itemKind !== "event" || problemsWithEventRevision(revision.act, revision.fields).length === 0;
  return { ...revision, sourceTime, accepted, rejection: accepted ? null : "invalid-fields", evidence: null };
}

/** What an Item's Revisions add up to, and the time it can be found by. */
export function project(kind: ItemKind, revisions: FoldableRevision[]): ItemProjection {
  const folded = fold(revisions);
  const event = kind === "event" ? eventOf(folded) : null;
  return { folded, window: event ? spanBounds(event.span) : null };
}
