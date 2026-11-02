import { describe, it, expect } from "vitest";
import { fold, type FoldableRevision } from "../src/item";

function revision(sequence: number, sourceTime: string, accepted: boolean, act: FoldableRevision["act"] = "create", fields: Record<string, unknown> = {}): FoldableRevision {
  return { sequence, sourceTime: new Date(sourceTime), accepted, act, fields };
}

describe("fold", () => {
  it("returns null for an empty array", () => {
    expect(fold([])).toBeNull();
  });

  it("returns null when the first revision received was rejected", () => {
    const revisions = [
      revision(1, "2026-01-01T00:00:00Z", false, "create", { title: "A" }),
      revision(2, "2026-01-02T00:00:00Z", true, "change", { title: "B" }),
    ];
    expect(fold(revisions)).toBeNull();
  });

  it("picks the lowest sequence as first, even if received out of order", () => {
    const revisions = [
      revision(2, "2026-01-02T00:00:00Z", false, "create", { title: "B" }),
      revision(1, "2026-01-01T00:00:00Z", true, "create", { title: "A" }),
    ];
    const result = fold(revisions);
    expect(result).not.toBeNull();
    expect(result!.fields).toEqual({ title: "A" });
  });

  it("applies revisions in source-time order", () => {
    const revisions = [
      revision(1, "2026-01-01T00:00:00Z", true, "create", { title: "A" }),
      revision(2, "2026-01-02T00:00:00Z", true, "change", { title: "B" }),
    ];
    const result = fold(revisions);
    expect(result!.fields.title).toBe("B");
  });

  it("marks cancelled on a cancel act", () => {
    const revisions = [
      revision(1, "2026-01-01T00:00:00Z", true, "create", { title: "A" }),
      revision(2, "2026-01-02T00:00:00Z", true, "cancel", {}),
    ];
    expect(fold(revisions)!.cancelled).toBe(true);
  });
});
