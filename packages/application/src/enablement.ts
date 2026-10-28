import type { MultilingualText } from "@family-agenda/domain";

/**
 * Something an Admin enables on its own: a Source Type (ADR-0010), or an entry of a Source Type's
 * catalogue, such as a Messenger (ADR-0011).
 */
export type Enableable = {
  /** Whether it can run as far as is known without loading its code, such as a bridge that is installed. */
  available(): Promise<boolean>;
  /** Shown before an Admin can enable it; null if there is none. */
  riskNotice: MultilingualText | null;
  /**
   * Records it as enabled, and does what that brings along, such as loading a plugin's code.
   * Returns false, enabling nothing, if it turns out not to run.
   */
  enable(): Promise<boolean>;
  /** Disables it unless a Source uses it. Returns whether it is disabled now, as one never enabled is. */
  disableIfUnused(): Promise<boolean>;
};

/** How each use case names what keeps something from being enabled or disabled. */
export type EnablementProblems = { unknown: string; unavailable: string; inUse: string };

export type EnableResult<P extends EnablementProblems> =
  | { ok: true }
  | { ok: false; problem: P["unknown"] | P["unavailable"] | "risk-not-acknowledged" };

export type DisableResult<P extends EnablementProblems> = { ok: true } | { ok: false; problem: P["unknown"] | P["inUse"] };

/**
 * Enables only what can run, and what carries a risk notice only once an Admin acknowledged it.
 * Nothing is ever enabled but here, at an Admin's request.
 */
export async function enableIfAllowed<P extends EnablementProblems>(
  candidate: Enableable | null,
  input: { riskAcknowledged?: boolean },
  problems: P,
): Promise<EnableResult<P>> {
  if (!candidate) return { ok: false, problem: problems.unknown };
  if (!(await candidate.available())) return { ok: false, problem: problems.unavailable };
  if (candidate.riskNotice !== null && input.riskAcknowledged !== true) return { ok: false, problem: "risk-not-acknowledged" };
  return (await candidate.enable()) ? { ok: true } : { ok: false, problem: problems.unavailable };
}

/** Disables only what no Source uses; an Admin removes those Sources first. */
export async function disableIfUnused<P extends EnablementProblems>(candidate: Enableable | null, problems: P): Promise<DisableResult<P>> {
  if (!candidate) return { ok: false, problem: problems.unknown };
  return (await candidate.disableIfUnused()) ? { ok: true } : { ok: false, problem: problems.inUse };
}
