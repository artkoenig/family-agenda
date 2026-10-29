import { describe, expect, it } from "vitest";
import { instantAt, quoteFoundIn, resolveDate, resolveDeadline, type DateMention, type LocalDate } from "../src";

const nothing: DateMention = { day: null, month: null, year: null, weekday: null, daysAfter: null, weeksAfter: null };

// Sent on Wednesday, 2026-11-04.
const sentOn = "2026-11-04" as LocalDate;

describe("a date as a message mentions it", () => {
  it.each([
    { case: "a full date", mention: { day: 12, month: 11, year: 2026 }, date: "2026-11-12" },
    { case: "a two-digit year", mention: { day: 12, month: 11, year: 26 }, date: "2026-11-12" },
    { case: "a date without a year, later this year", mention: { day: 12, month: 11 }, date: "2026-11-12" },
    { case: "a date without a year, early next year", mention: { day: 15, month: 1 }, date: "2027-01-15" },
    { case: "a date without a year, a few weeks back", mention: { day: 20, month: 10 }, date: "2026-10-20" },
    { case: "a date with the weekday it falls on", mention: { day: 13, month: 11, weekday: "friday" }, date: "2026-11-13" },
    { case: "today", mention: { daysAfter: 0 }, date: "2026-11-04" },
    { case: "tomorrow", mention: { daysAfter: 1 }, date: "2026-11-05" },
    { case: "in two weeks", mention: { daysAfter: 14 }, date: "2026-11-18" },
    { case: "a weekday alone, later this week", mention: { weekday: "friday" }, date: "2026-11-06" },
    { case: "a weekday alone, earlier in the week", mention: { weekday: "monday" }, date: "2026-11-09" },
    { case: "the weekday it was sent on", mention: { weekday: "wednesday" }, date: "2026-11-11" },
    { case: "a weekday next week", mention: { weekday: "tuesday", weeksAfter: 1 }, date: "2026-11-10" },
    { case: "a weekday this week", mention: { weekday: "friday", weeksAfter: 0 }, date: "2026-11-06" },
  ] as const)("resolves $case against the day it was sent", ({ mention, date }) => {
    expect(resolveDate({ ...nothing, ...mention }, sentOn)).toEqual({ ok: true, date });
  });

  it.each([
    { case: "a date with a weekday it does not fall on", mention: { day: 12, month: 11, weekday: "wednesday" }, problem: { problem: "weekday-mismatch", date: "2026-11-12" } },
    { case: "tomorrow, said to be a Friday", mention: { daysAfter: 1, weekday: "friday" }, problem: { problem: "weekday-mismatch", date: "2026-11-05" } },
    { case: "a date that does not exist", mention: { day: 31, month: 11 }, problem: { problem: "no-date" } },
    { case: "a day without a month", mention: { day: 12 }, problem: { problem: "no-date" } },
    { case: "a day without a month, next to a weekday", mention: { day: 5, weekday: "friday" }, problem: { problem: "no-date" } },
    { case: "no date at all", mention: {}, problem: { problem: "no-date" } },
  ] as const)("refuses $case", ({ mention, problem }) => {
    expect(resolveDate({ ...nothing, ...mention }, sentOn)).toEqual({ ok: false, ...problem });
  });
});

describe("a Deadline as a message mentions it", () => {
  it.each([
    { case: "the end of a month", mention: { month: 11, year: 2026 }, date: "2026-11-30" },
    { case: "the end of February in a leap year", mention: { month: 2, year: 28 }, date: "2028-02-29" },
    { case: "a month without a year, later this year", mention: { month: 12 }, date: "2026-12-31" },
    { case: "a month without a year, early next year", mention: { month: 1 }, date: "2027-01-31" },
    { case: "a month without a year, just over", mention: { month: 10 }, date: "2026-10-31" },
    { case: "a full date", mention: { day: 12, month: 11, year: 2026 }, date: "2026-11-12" },
  ] as const)("resolves $case to the latest day in time", ({ mention, date }) => {
    expect(resolveDeadline({ ...nothing, ...mention }, sentOn)).toEqual({ ok: true, date });
  });

  it("refuses a month that does not exist, as an Event's date does", () => {
    expect(resolveDeadline({ ...nothing, month: 13, year: 2026 }, sentOn)).toEqual({ ok: false, problem: "no-date" });
    expect(resolveDate({ ...nothing, month: 11, year: 2026 }, sentOn)).toEqual({ ok: false, problem: "no-date" });
  });
});

describe("a time on the Family's clocks", () => {
  it("is the instant it shows in the time zone, in summer and in winter time", () => {
    expect(instantAt("2026-07-01" as LocalDate, "16:00", "Europe/Berlin")).toEqual(new Date("2026-07-01T14:00:00Z"));
    expect(instantAt("2026-11-12" as LocalDate, "19:30", "Europe/Berlin")).toEqual(new Date("2026-11-12T18:30:00Z"));
    expect(instantAt("2026-11-12" as LocalDate, "08:00", "America/New_York")).toEqual(new Date("2026-11-12T13:00:00Z"));
  });

  it("is refused when it is no time", () => {
    expect(instantAt("2026-11-12" as LocalDate, "25:00", "Europe/Berlin")).toBeNull();
    expect(instantAt("2026-11-12" as LocalDate, "7 pm", "Europe/Berlin")).toBeNull();
  });
});

describe("an evidence quote", () => {
  const message = "Liebe Eltern,\n\nder Elternabend der Klasse 5b findet am\nDonnerstag, 12.11., um 19:30 Uhr statt.";

  it("is found when the message says it word for word, whatever the line breaks and spaces", () => {
    expect(quoteFoundIn("Elternabend der Klasse 5b", message)).toBe(true);
    expect(quoteFoundIn("findet am Donnerstag,  12.11., um 19:30 Uhr", message)).toBe(true);
  });

  it("is not found when the message says something else, or nothing", () => {
    expect(quoteFoundIn("Elternabend am Mittwoch", message)).toBe(false);
    expect(quoteFoundIn("elternabend der klasse 5b", message)).toBe(false);
    expect(quoteFoundIn("  ", message)).toBe(false);
  });
});
