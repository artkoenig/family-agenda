import { describe, it, expect } from "vitest";
import { isAgendaKind, isAcceptableHorizon, isAcceptableTimelineRange } from "../src/agenda";
import type { LocalDate } from "../src/calendar";

describe("isAgendaKind", () => {
  it("accepts 'timeline'", () => {
    expect(isAgendaKind("timeline")).toBe(true);
  });

  it("accepts 'tasks'", () => {
    expect(isAgendaKind("tasks")).toBe(true);
  });

  it("rejects other strings", () => {
    expect(isAgendaKind("calendar")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isAgendaKind("")).toBe(false);
  });

  it("rejects case variants", () => {
    expect(isAgendaKind("Timeline")).toBe(false);
  });
});

describe("isAcceptableHorizon", () => {
  it("accepts 1", () => {
    expect(isAcceptableHorizon(1)).toBe(true);
  });

  it("accepts 7 (default)", () => {
    expect(isAcceptableHorizon(7)).toBe(true);
  });

  it("accepts 31 (max)", () => {
    expect(isAcceptableHorizon(31)).toBe(true);
  });

  it("rejects 0", () => {
    expect(isAcceptableHorizon(0)).toBe(false);
  });

  it("rejects 32 (over max)", () => {
    expect(isAcceptableHorizon(32)).toBe(false);
  });

  it("rejects negative", () => {
    expect(isAcceptableHorizon(-1)).toBe(false);
  });

  it("rejects non-integer", () => {
    expect(isAcceptableHorizon(1.5)).toBe(false);
  });
});

describe("isAcceptableTimelineRange", () => {
  it("accepts a single day", () => {
    expect(isAcceptableTimelineRange("2026-03-15" as LocalDate, "2026-03-15" as LocalDate)).toBe(true);
  });

  it("accepts a range of 366 days (leap year)", () => {
    // Jan 1 to Dec 31 of a leap year = 365 days apart + 1 = 366 days
    expect(isAcceptableTimelineRange("2028-01-01" as LocalDate, "2028-12-31" as LocalDate)).toBe(true);
  });

  it("rejects a range of 367 days", () => {
    // Jan 1 of leap year to Jan 1 of next year = 366 days apart + 1 = 367 days
    expect(isAcceptableTimelineRange("2028-01-01" as LocalDate, "2029-01-01" as LocalDate)).toBe(false);
  });

  it("rejects reversed range (last before first)", () => {
    expect(isAcceptableTimelineRange("2026-03-20" as LocalDate, "2026-03-15" as LocalDate)).toBe(false);
  });

  it("accepts a typical week", () => {
    expect(isAcceptableTimelineRange("2026-03-10" as LocalDate, "2026-03-16" as LocalDate)).toBe(true);
  });
});
