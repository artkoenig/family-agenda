import type { FamilyId } from "./family";
import type { FamilyMemberId } from "./family-member";

export type ViewId = string & { readonly __brand: "ViewId" };

/** A View's only settings are its preselected Family Members and its horizon. */
export type View = {
  id: ViewId;
  familyId: FamilyId;
  /** Whom the quick filter starts with; none means the whole Family. */
  preselected: FamilyMemberId[];
  /** How many days the timeline shows, today included. */
  horizonDays: number;
  createdAt: Date;
};

export const horizonDaysRange = { min: 1, max: 31 };

export function isAcceptableHorizon(days: number): boolean {
  return Number.isInteger(days) && days >= horizonDaysRange.min && days <= horizonDaysRange.max;
}
