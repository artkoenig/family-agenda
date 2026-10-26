import type { FamilyId } from "./family";
import type { Photo } from "./photo";

export type FamilyMemberId = string & { readonly __brand: "FamilyMemberId" };

export type FamilyMember = {
  id: FamilyMemberId;
  familyId: FamilyId;
  name: string;
  photo: Photo | null;
  createdAt: Date;
};

export const maximumNameLength = 40;

/** Names are kept without surrounding whitespace; null if nothing is left or it is too long. */
export function parseName(raw: string): string | null {
  const name = raw.trim();
  return name.length > 0 && name.length <= maximumNameLength ? name : null;
}

/** What an avatar shows when a Family Member has no photo. */
export function initialOf(name: string): string {
  const [first = ""] = name;
  return first.toUpperCase();
}
