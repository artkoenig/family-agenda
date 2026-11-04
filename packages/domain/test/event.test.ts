import { describe, expect, it } from "vitest";
import { eventOf, problemsWithEventFields, spanOnDay, lastDayOf, maximumEventTextLength, type LocalDate } from "../src";

const timed = (start: string, end: string) => ({ allDay: false, start, end });

/** The problems of fields that state only some of an Event, the rest being fine. */
const completed = (fields: Record<string, unknown>) =>
  problemsWithEventFields({ title: "Piano", span: timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z"), ...fields });

describe("an Event's fields", () => {
  it.each([
    {
      case: "fields with title, span and place",
      fields: { title: "Piano", span: timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z"), place: "Music school" },
      problems: [],
    },
    {
      case: "an all-day create without a place",
      fields: { title: "Trip", span: { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-19" }, place: null },
      problems: [],
    },
    { case: "fields without a span", fields: { title: "Piano" }, problems: ["span is missing"] },
    {
      case: "fields with fields no Event has, an empty title and a backwards span",
      partial: true,
      fields: { title: " ", colour: "red", span: timed("2026-09-15T15:00:00.000Z", "2026-09-15T14:00:00.000Z") },
      problems: ["title is not a non-empty text", "span is not a valid time span", "colour is not a field of an Event"],
    },
    {
      case: "an all-day span with a date that does not exist",
      partial: true,
      fields: { span: { allDay: true, firstDay: "2026-02-30", lastDay: "2026-03-01" } },
      problems: ["span is not a valid time span"],
    },
    {
      case: "a place that is an empty string (not null)",
      fields: { title: "Piano", span: timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z"), place: "" },
      problems: ["place is not a non-empty text or null"],
    },
    {
      case: "a place that is too long",
      fields: { title: "Piano", span: timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z"), place: "x".repeat(501) },
      problems: ["place is not a non-empty text or null"],
    },
  ])("$case", ({ partial, fields, problems }) => {
    expect(partial ? completed(fields) : problemsWithEventFields(fields)).toEqual(problems);
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

  it("is null when it has a span but no title", () => {
    const span = timed("2026-09-15T14:00:00.000Z", "2026-09-15T15:00:00.000Z");
    expect(eventOf({ fields: { span }, cancelled: false })).toBeNull();
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
    { case: "all day, before its days", span: { allDay: true as const, firstDay: day("2026-09-18"), lastDay: day("2026-09-19") }, day: "2026-09-17", on: null },
    { case: "all day, on its first day (boundary)", span: { allDay: true as const, firstDay: day("2026-09-18"), lastDay: day("2026-09-19") }, day: "2026-09-18", on: { from: null, until: null } },
  ])("$case", ({ span, day: date, on }) => {
    expect(spanOnDay(span, day(date), berlin)).toEqual(on);
  });

  it("is null for a timed span before its start day", () => {
    const span = { allDay: false as const, start: new Date("2026-09-15T14:00:00Z"), end: new Date("2026-09-15T15:00:00Z") };
    expect(spanOnDay(span, day("2026-09-14"), berlin)).toBeNull();
  });
});

describe("lastDayOf", () => {
  const berlin = "Europe/Berlin";

  it("returns span.lastDay for an all-day span", () => {
    const span = { allDay: true as const, firstDay: "2026-09-18" as LocalDate, lastDay: "2026-09-19" as LocalDate };
    expect(lastDayOf(span, berlin)).toBe("2026-09-19");
  });

  it("returns the start date for a zero-duration span", () => {
    const span = { allDay: false as const, start: new Date("2026-09-15T14:00:00Z"), end: new Date("2026-09-15T14:00:00Z") };
    expect(lastDayOf(span, berlin)).toBe("2026-09-15");
  });

  it("returns the end date minus 1ms for a span that ends at midnight", () => {
    const span = { allDay: false as const, start: new Date("2026-09-15T14:00:00Z"), end: new Date("2026-09-15T22:00:00Z") };
    expect(lastDayOf(span, berlin)).toBe("2026-09-15");
  });
});

describe("parseSpan (via problemsWithEventFields)", () => {
  it("rejects a null span", () => {
    expect(completed({ span: null })).toContain("span is not a valid time span");
  });

  it("rejects a non-object span (a string)", () => {
    expect(completed({ span: "not-a-span" })).toContain("span is not a valid time span");
  });

  it("rejects an all-day span where allDay is not true or false", () => {
    expect(completed({ span: { allDay: undefined, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" } })).toContain("span is not a valid time span");
  });

  it("rejects a timed span with allDay=true (wrong branch)", () => {
    expect(completed({ span: { allDay: true, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" } })).toContain("span is not a valid time span");
  });

  it("rejects a timed span with a non-string start", () => {
    expect(completed({ span: { allDay: false, start: 123, end: "2026-09-15T15:00:00Z" } })).toContain("span is not a valid time span");
  });

  it("rejects a timed span with a non-string end", () => {
    expect(completed({ span: { allDay: false, start: "2026-09-15T14:00:00Z", end: 123 } })).toContain("span is not a valid time span");
  });

  it("rejects a timed span with a non-parseable start date", () => {
    expect(completed({ span: { allDay: false, start: "not-a-date", end: "2026-09-15T15:00:00Z" } })).toContain("span is not a valid time span");
  });

  it("accepts a zero-duration span (end === start is valid for events)", () => {
    expect(completed({ span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T14:00:00Z" } })).not.toContain("span is not a valid time span");
  });

  it("rejects a timed span where end is before start", () => {
    expect(completed({ span: { allDay: false, start: "2026-09-15T15:00:00Z", end: "2026-09-15T14:00:00Z" } })).toContain("span is not a valid time span");
  });

  it("rejects an all-day span with firstDay > lastDay", () => {
    expect(completed({ span: { allDay: true, firstDay: "2026-09-19", lastDay: "2026-09-18" } })).toContain("span is not a valid time span");
  });

  it("rejects an all-day span with firstDay null", () => {
    expect(completed({ span: { allDay: true, firstDay: null, lastDay: "2026-09-18" } })).toContain("span is not a valid time span");
  });

  it("rejects an all-day span with lastDay null", () => {
    expect(completed({ span: { allDay: true, firstDay: "2026-09-18", lastDay: null } })).toContain("span is not a valid time span");
  });

  it("accepts an all-day span with firstDay === lastDay (single day)", () => {
    expect(completed({ span: { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-18" } })).not.toContain("span is not a valid time span");
  });

  it("rejects an all-day span with a non-string firstDay", () => {
    expect(completed({ span: { allDay: true, firstDay: 123, lastDay: "2026-09-18" } })).toContain("span is not a valid time span");
  });

  it("rejects an all-day span with a date not at the start of the string", () => {
    expect(completed({ span: { allDay: true, firstDay: "x2026-09-18", lastDay: "2026-09-18" } })).toContain("span is not a valid time span");
  });

  it("rejects an all-day span with a date not at the end of the string", () => {
    expect(completed({ span: { allDay: true, firstDay: "2026-09-18x", lastDay: "2026-09-18" } })).toContain("span is not a valid time span");
  });

  it("accepts a valid all-day span", () => {
    const problems = completed({ span: { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-19" } });
    expect(problems).not.toContain("span is not a valid time span");
  });
});

describe("parseText (via problemsWithEventFields)", () => {
  it("rejects a title of exactly maximumEventTextLength + 1", () => {
    const title = "x".repeat(maximumEventTextLength + 1);
    expect(problemsWithEventFields({ title, span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" } })).toContain("title is not a non-empty text");
  });

  it("accepts a title of exactly maximumEventTextLength", () => {
    const title = "x".repeat(maximumEventTextLength);
    expect(problemsWithEventFields({ title, span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" } })).not.toContain("title is not a non-empty text");
  });

  it("rejects a title that is whitespace only", () => {
    expect(problemsWithEventFields({ title: "   ", span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" } })).toContain("title is not a non-empty text");
  });

  it("rejects a non-string title", () => {
    expect(problemsWithEventFields({ title: 123, span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" } })).toContain("title is not a non-empty text");
  });
});
