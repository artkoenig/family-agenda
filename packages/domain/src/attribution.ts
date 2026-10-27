import type { FamilyId } from "./family";
import type { FamilyMemberId } from "./family-member";
import type { SourceId } from "./source";

export type AttributionRuleId = string & { readonly __brand: "AttributionRuleId" };

/**
 * Whom an Item concerns: some Family Members, or the whole Family, which is its own value and
 * not the same as listing everyone (decided in #8).
 */
export type Attribution = FamilyMemberId[] | "whole-family";

/**
 * An Admin's rule that assigns the Items of a Source's Origins to Family Members, or to the
 * whole Family, by the value of one Origin attribute its plugin declares, such as a sender;
 * never by what the content mentions.
 */
export type AttributionRule = {
  id: AttributionRuleId;
  familyId: FamilyId;
  sourceId: SourceId;
  /** The key of the Origin attribute, as the Source's plugin declares it. */
  attribute: string;
  value: string;
  /** Family Members removed since are no longer listed. */
  concerns: Attribution;
  createdAt: Date;
};

/** Where an Item appeared: a Source, and the values of its plugin's Origin attributes. */
export type OriginOf = { sourceId: SourceId; attributes: Record<string, string> };

export const maximumAttributeValueLength = 500;

/** Values are matched without surrounding whitespace; null if nothing is left or it is too long. */
export function parseAttributeValue(raw: string): string | null {
  const value = raw.trim();
  return value.length > 0 && value.length <= maximumAttributeValueLength ? value : null;
}

/** Whether an Origin's attribute value is a rule's, whatever their case, as for a sender address. */
function sameValue(a: string | undefined, b: string): boolean {
  return a !== undefined && a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}

/**
 * Whom an Item concerns, by the rules its Origins match: the union of what they assign, the
 * whole Family covering everyone. Without a matching rule, the whole Family. A rule left without
 * anyone, as when its Family Members were removed, matches nothing. Applying it on every read
 * makes a rule apply retroactively.
 */
export function attributionOf(origins: readonly OriginOf[], rules: readonly AttributionRule[]): Attribution {
  const matched = rules.filter(
    (rule) =>
      (rule.concerns === "whole-family" || rule.concerns.length > 0) &&
      origins.some((origin) => origin.sourceId === rule.sourceId && sameValue(origin.attributes[rule.attribute], rule.value)),
  );
  if (matched.length === 0 || matched.some((rule) => rule.concerns === "whole-family")) return "whole-family";
  return [...new Set(matched.flatMap((rule) => rule.concerns as FamilyMemberId[]))];
}

/**
 * Whether the quick filter, showing some Family Members, shows an Item: if it concerns one of
 * them, and always if it concerns the whole Family.
 */
export function isShownTo(attribution: Attribution, showing: readonly FamilyMemberId[]): boolean {
  return attribution === "whole-family" || attribution.some((member) => showing.includes(member));
}
