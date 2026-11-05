import type { FamilyMemberId } from "./family-member";

/**
 * Whom an Item concerns: some Family Members, or the whole Family, which is its own value and
 * not the same as listing everyone (decided in #8).
 */
export type Attribution = FamilyMemberId[] | "whole-family";

/**
 * Whom an Item concerns, by the Family Members assigned to the Sources of its Origins: the union
 * of them, a Source assigned to no one covering everyone. Nothing within a Source, such as a
 * sender, counts. Applying it on every read makes assigning a Source apply to its past Items.
 */
// eslint-disable-next-line sonarjs/function-return-type -- intentionally returns different members of the Attribution union
export function attributionOf(assignedPerSource: readonly (readonly FamilyMemberId[])[]): Attribution {
  if (assignedPerSource.length === 0 || assignedPerSource.some((assigned) => assigned.length === 0)) return "whole-family";
  return [...new Set(assignedPerSource.flat())];
}

/**
 * Whether an Agenda or quick filter showing some Family Members shows an Item: only if it concerns
 * one of them. An Item that concerns the whole Family is not shown to chosen members; only an Agenda
 * for the whole Family shows it, and that one does not filter.
 */
export function isShownTo(attribution: Attribution, showing: readonly FamilyMemberId[]): boolean {
  return attribution !== "whole-family" && attribution.some((member) => showing.includes(member));
}
