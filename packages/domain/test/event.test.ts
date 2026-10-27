import { describe, expect, it } from "vitest";
import { eventOf, problemsWithEventRevision, spanOnDay, type LocalDate } from "../src";

const timed = (start: string, end: string) => ({ allDay: false, start, end });

describe("an Event Revision", () => {
  it.each([
    {
      case: "a create with title, span and place",
      act: "create" as const,
      fields: { title: "Piano", span: timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z"), place: "Music school" },
      problems: [],
    },
    {
      case: "an all-day create without a place",
      act: "create" as const,
      fields: { title: "Trip", span: { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-19" }, place: null },
      problems: [],
    },
    { case: "a create without a span", act: "create" as const, fields: { title: "Piano" }, problems: ["span is missing"] },
    { case: "a cancel with no fields", act: "cancel" as const, fields: {}, problems: [] },
    { case: "a move without a span", act: "move" as const, fields: {}, problems: ["span is missing"] },
    {
      case: "a change with fields no Event has, an empty title and a backwards span",
      act: "change" as const,
      fields: { title: " ", colour: "red", span: timed("2026-09-15T15:00:00.000Z", "2026-09-15T14:00:00.000Z") },
      problems: ["title is not a non-empty text", "span is not a valid time span", "colour is not a field of an Event"],
    },
    {
      case: "an all-day span with a date that does not exist",
      act: "change" as const,
      fields: { span: { allDay: true, firstDay: "2026-02-30", lastDay: "2026-03-01" } },
      problems: ["span is not a valid time span"],
    },
  ])("$case", ({ act, fields, problems }) => {
    expect(problemsWithEventRevision(act, fields)).toEqual(problems);
  });
});

describe("an Event", () => {
  it("is what the folded fields describe, or nothing while it lacks a title or span", () => {
    const span = timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z");
    expect(eventOf({ fields: { title: "Piano", span }, cancelled: true })).toEqual({
      title: "Piano",
      span: { allDay: false, start: new Date(span.start), end: new Date(span.end) },
      place: null,
      cancelled: true,
    });
    expect(eventOf({ fields: { title: "Piano" }, cancelled: false })).toBeNull();
    expect(eventOf(null)).toBeNull();
  });
});

describe("an Event's span on a day of the Family", () => {
  const berlin = "Europe/Berlin";
  const day = (date: string) => date as LocalDate;
  const span = (start: string, end: string) => ({ allDay: false as const, start: new Date(start), end: new Date(end) });

  it.each([
    { case: "within the day", span: span("2026-09-15T14:00:00Z", "2026-09-15T15:30:00Z"), day: "2026-09-15", on: { from: "16:00", until: "17:30" } },
    { case: "on another day", span: span("2026-09-15T14:00:00Z", "2026-09-15T15:30:00Z"), day: "2026-09-16", on: null },
    { case: "over midnight, on its first day", span: span("2026-09-15T18:00:00Z", "2026-09-16T08:00:00Z"), day: "2026-09-15", on: { from: "20:00", until: null } },
    { case: "over midnight, on its last day", span: span("2026-09-15T18:00:00Z", "2026-09-16T08:00:00Z"), day: "2026-09-16", on: { from: null, until: "10:00" } },
    { case: "ending at midnight, not on the next day", span: span("2026-09-15T18:00:00Z", "2026-09-15T22:00:00Z"), day: "2026-09-16", on: null },
    { case: "without duration", span: span("2026-09-15T14:00:00Z", "2026-09-15T14:00:00Z"), day: "2026-09-15", on: { from: "16:00", until: "16:00" } },
    { case: "all day, within its days", span: { allDay: true as const, firstDay: day("2026-09-18"), lastDay: day("2026-09-19") }, day: "2026-09-19", on: { from: null, until: null } },
    { case: "all day, after its days", span: { allDay: true as const, firstDay: day("2026-09-18"), lastDay: day("2026-09-19") }, day: "2026-09-20", on: null },
  ])("$case", ({ span, day: date, on }) => {
    expect(spanOnDay(span, day(date), berlin)).toEqual(on);
  });
});
