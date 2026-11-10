import type { Photo } from "./photo";

export type FamilyMemberId = string & { readonly __brand: "FamilyMemberId" };

export type FamilyMember = {
  id: FamilyMemberId;
  name: string;
  photo: Photo | null;
  /** The avatar colour behind the initial, one of `memberColours`. */
  colour: MemberColour;
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

/** The eight avatar colours, by number; the design system names them `--member-1` to `--member-8`. */
export const memberColours = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export type MemberColour = (typeof memberColours)[number];

/** A colour from a form field; null if it is none of `memberColours`. */
export function parseColour(raw: string): MemberColour | null {
  return memberColours.find((colour) => String(colour) === raw.trim()) ?? null;
}

/** The colour for a new Family Member: the one the fewest others have, the lowest of those. */
export function nextColour(taken: readonly MemberColour[]): MemberColour {
  const uses = (colour: MemberColour) => taken.filter((other) => other === colour).length;
  return memberColours.reduce((best, colour) => (uses(colour) < uses(best) ? colour : best));
}
