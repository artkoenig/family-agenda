/** The id a Source plugin gives its Source Type, such as `ics`; the core never branches on it. */
export type SourceTypeId = string & { readonly __brand: "SourceTypeId" };

export type SourceId = string & { readonly __brand: "SourceId" };

/** A subdivision of a Source that its plugin reports, such as a mail folder (ADR-0016). */
export type SourceAttributeId = string & { readonly __brand: "SourceAttributeId" };

/**
 * Whether a Source works: OK, Failing when it needs an Admin, or Silent when no new Origin has
 * come for a while from a Source Type that expects them.
 */
export type SourceStatus = "ok" | "failing" | "silent";

/** Why a run of a Source failed: a definite error needs an Admin, a temporary one may pass. */
export type RunError = { kind: "definite" | "temporary"; message: string };

/**
 * Failed runs not yet followed by a successful one: the last error, and since when it fails. Its
 * kind is definite once any of them was, since only a successful run shows that it was fixed.
 */
export type SourceFailure = RunError & { since: Date };

/** How long temporary errors may last before a Source is Failing. */
export const failingAfterMs = 6 * 60 * 60 * 1000;

/** How long a Source of a Source Type that declares Silent may go without a new Origin. */
export const silentAfterMs = 14 * 24 * 60 * 60 * 1000;

/**
 * The status of a Source whose plugin is loaded. A definite error makes it Failing at once,
 * temporary ones after `failingAfterMs`. Silent counts from the last new Origin, or from when the
 * Source was added if none came yet.
 */
export function sourceStatus(source: {
  failure: SourceFailure | null;
  silentApplies: boolean;
  lastNewOriginAt: Date | null;
  createdAt: Date;
  now: Date;
}): SourceStatus {
  const { failure, now } = source;
  if (failure) {
    if (failure.kind === "definite" || now.getTime() - failure.since.getTime() >= failingAfterMs) return "failing";
  }
  const lastNewOrigin = source.lastNewOriginAt ?? source.createdAt;
  if (source.silentApplies && now.getTime() - lastNewOrigin.getTime() >= silentAfterMs) return "silent";
  return "ok";
}
