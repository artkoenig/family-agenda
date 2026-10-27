import { describe, expect, it } from "vitest";
import { fold, type FoldableRevision } from "../src";

const at = (time: string) => new Date(`2026-09-${time}Z`);

/** A Revision as it is folded; `sequence` is the order it was received in. */
const revision = (
  act: FoldableRevision["act"],
  sourceTime: string,
  fields: Record<string, unknown> = {},
  more: Partial<FoldableRevision> = {},
): FoldableRevision => ({ act, fields, sourceTime: at(sourceTime), sequence: 0, accepted: true, ...more });

describe("folding Revisions into an Item", () => {
  it.each([
    {
      case: "a create states every field it carries",
      revisions: [revision("create", "01T10:00:00", { title: "Match", place: "Field 2" })],
      folded: { fields: { title: "Match", place: "Field 2" }, cancelled: false },
    },
    {
      case: "a later change wins only the fields it carries",
      revisions: [
        revision("create", "01T10:00:00", { title: "Match", place: "Field 2" }),
        revision("change", "02T10:00:00", { place: "Field 4" }),
      ],
      folded: { fields: { title: "Match", place: "Field 4" }, cancelled: false },
    },
    {
      case: "the newest source time wins, whatever the order of arrival",
      revisions: [
        revision("change", "03T10:00:00", { place: "Field 4" }, { sequence: 1 }),
        revision("create", "01T10:00:00", { title: "Match", place: "Field 2" }, { sequence: 2 }),
        revision("move", "02T10:00:00", { place: "Field 3", span: "late" }, { sequence: 3 }),
      ],
      folded: { fields: { title: "Match", place: "Field 4", span: "late" }, cancelled: false },
    },
    {
      case: "of two Revisions with the same source time, the one received later wins",
      revisions: [
        revision("change", "02T10:00:00", { place: "B" }, { sequence: 2 }),
        revision("change", "02T10:00:00", { place: "A" }, { sequence: 1 }),
        revision("create", "01T10:00:00", { title: "Match" }),
      ],
      folded: { fields: { title: "Match", place: "B" }, cancelled: false },
    },
    {
      case: "a cancel keeps the fields and marks the Item cancelled",
      revisions: [
        revision("create", "01T10:00:00", { title: "Match" }),
        revision("cancel", "02T10:00:00"),
      ],
      folded: { fields: { title: "Match" }, cancelled: true },
    },
    {
      case: "a change after a cancel leaves it cancelled",
      revisions: [
        revision("create", "01T10:00:00", { title: "Match" }),
        revision("cancel", "02T10:00:00"),
        revision("change", "03T10:00:00", { title: "Final" }),
      ],
      folded: { fields: { title: "Final" }, cancelled: true },
    },
    {
      case: "a create after a cancel restores the Item",
      revisions: [
        revision("cancel", "02T10:00:00"),
        revision("create", "03T10:00:00", { title: "Match" }),
      ],
      folded: { fields: { title: "Match" }, cancelled: false },
    },
    {
      case: "a cancel that arrives before its create still cancels",
      revisions: [
        revision("cancel", "02T10:00:00", {}, { sequence: 1 }),
        revision("create", "01T10:00:00", { title: "Match" }, { sequence: 2 }),
      ],
      folded: { fields: { title: "Match" }, cancelled: true },
    },
    {
      case: "a rejected Revision no longer counts",
      revisions: [
        revision("create", "01T10:00:00", { title: "Match" }),
        revision("change", "02T10:00:00", { title: "Wrong" }, { accepted: false }),
      ],
      folded: { fields: { title: "Match" }, cancelled: false },
    },
    {
      case: "rejecting the first Revision received removes the Item, and later ones do not bring it back",
      revisions: [
        revision("create", "01T10:00:00", { title: "Wrong" }, { sequence: 1, accepted: false }),
        revision("change", "02T10:00:00", { title: "Match" }, { sequence: 2 }),
        revision("create", "03T10:00:00", { title: "Match" }, { sequence: 3 }),
      ],
      folded: null,
    },
    {
      case: "the first Revision received decides, even if its source time is later",
      revisions: [
        revision("change", "02T10:00:00", { place: "Field 4" }, { sequence: 1 }),
        revision("create", "01T10:00:00", { title: "Wrong" }, { sequence: 2, accepted: false }),
      ],
      folded: { fields: { place: "Field 4" }, cancelled: false },
    },
    {
      case: "without accepted Revisions there is no Item",
      revisions: [revision("create", "01T10:00:00", { title: "Wrong" }, { accepted: false })],
      folded: null,
    },
  ])("$case", ({ revisions, folded }) => {
    expect(fold(revisions)).toEqual(folded);
  });
});
