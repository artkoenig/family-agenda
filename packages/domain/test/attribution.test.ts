import { describe, it, expect } from "vitest";
import { attributionOf, isShownTo, type Attribution } from "../src/attribution";
import type { FamilyMemberId } from "../src/family-member";

const alice = "alice" as FamilyMemberId;
const bob = "bob" as FamilyMemberId;
const carol = "carol" as FamilyMemberId;

describe("attributionOf", () => {
  it("returns 'whole-family' when there are no sources", () => {
    expect(attributionOf([])).toBe("whole-family");
  });

  it("returns 'whole-family' when a source has no assigned members", () => {
    expect(attributionOf([[alice], []])).toBe("whole-family");
  });

  it("returns the single member for one source with one member", () => {
    expect(attributionOf([[alice]])).toEqual([alice]);
  });

  it("returns the union of members across sources", () => {
    expect(attributionOf([[alice], [bob]])).toEqual([alice, bob]);
  });

  it("deduplicates members appearing in multiple sources", () => {
    expect(attributionOf([[alice, bob], [bob, carol]])).toEqual([alice, bob, carol]);
  });

  it("returns 'whole-family' if any source is unassigned", () => {
    expect(attributionOf([[alice], [], [bob]])).toBe("whole-family");
  });
});

describe("isShownTo", () => {
  it("does not show 'whole-family' attribution to chosen members", () => {
    expect(isShownTo("whole-family", [alice])).toBe(false);
  });

  it("shows when the member is in the attribution", () => {
    expect(isShownTo([alice, bob] as Attribution, [alice])).toBe(true);
  });

  it("does not show when the member is not in the attribution", () => {
    expect(isShownTo([alice, bob] as Attribution, [carol])).toBe(false);
  });

  it("shows when any of the showing members matches", () => {
    expect(isShownTo([alice] as Attribution, [bob, alice])).toBe(true);
  });

  it("does not show for empty showing list with specific attribution", () => {
    expect(isShownTo([alice] as Attribution, [])).toBe(false);
  });

  it("does not show 'whole-family' attribution for an empty showing list", () => {
    expect(isShownTo("whole-family", [])).toBe(false);
  });
});
