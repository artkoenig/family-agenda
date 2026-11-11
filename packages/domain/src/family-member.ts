import type { Photo } from "./photo";

export type FamilyMemberId = string & { readonly __brand: "FamilyMemberId" };

export type FamilyMember = {
  id: FamilyMemberId;
  name: string;
  photo: Photo | null;
  /** The avatar colour behind the initial, one of `memberColours`. */
  colour: MemberColour;
  /** The animal shown on the colour instead of the initial, if any; a photo goes before both. */
  avatar: MemberAvatar | null;
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

/** The animals a Family Member can show instead of their initial, by their names in Fluent Emoji (flat). */
export const memberAvatars = [
  "bear", "polar-bear", "panda", "koala", "fox", "wolf", "raccoon", "hedgehog",
  "rabbit-face", "mouse-face", "hamster", "cat-face", "dog-face", "tiger-face", "lion", "monkey-face",
  "cow-face", "pig-face", "unicorn", "owl", "penguin", "front-facing-baby-chick", "frog", "octopus",
] as const;

export type MemberAvatar = (typeof memberAvatars)[number];

/** An animal from a form field: an empty field means none, and anything else unknown is refused. */
export function parseAvatar(raw: string): { ok: true; avatar: MemberAvatar | null } | { ok: false } {
  const value = raw.trim();
  if (value === "") return { ok: true, avatar: null };
  const avatar = memberAvatars.find((known) => known === value);
  return avatar ? { ok: true, avatar } : { ok: false };
}
