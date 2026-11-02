import { describe, it, expect } from "vitest";
import { localDateTime, addDays, daysBetween, isLocalDate, type LocalDate } from "../src/calendar";

describe("localDateTime", () => {
  it("returns date and time in UTC", () => {
    const result = localDateTime(new Date("2026-03-15T14:30:00Z"), "UTC");
    expect(result.date).toBe("2026-03-15");
    expect(result.time).toBe("14:30");
  });

  it("returns date and time in a positive offset zone (summer, UTC+2)", () => {
    const result = localDateTime(new Date("2026-07-15T14:30:00Z"), "Europe/Berlin");
    expect(result.date).toBe("2026-07-15");
    expect(result.time).toBe("16:30");
  });

  it("returns date and time in a positive offset zone (winter, UTC+1)", () => {
    const result = localDateTime(new Date("2026-01-15T14:30:00Z"), "Europe/Berlin");
    expect(result.date).toBe("2026-01-15");
    expect(result.time).toBe("15:30");
  });

  it("returns date and time in a negative offset zone", () => {
    const result = localDateTime(new Date("2026-01-15T14:30:00Z"), "America/New_York");
    expect(result.date).toBe("2026-01-15");
    expect(result.time).toBe("09:30");
  });

  it("handles date rollover to next day", () => {
    const result = localDateTime(new Date("2026-07-15T23:30:00Z"), "Europe/Berlin");
    expect(result.date).toBe("2026-07-16");
    expect(result.time).toBe("01:30");
  });

  it("handles date rollover to previous day", () => {
    const result = localDateTime(new Date("2026-01-15T01:30:00Z"), "America/New_York");
    expect(result.date).toBe("2026-01-14");
    expect(result.time).toBe("20:30");
  });

  it("handles midnight boundary", () => {
    const result = localDateTime(new Date("2026-03-15T00:00:00Z"), "UTC");
    expect(result.date).toBe("2026-03-15");
    expect(result.time).toBe("00:00");
  });

  it("handles year boundary", () => {
    const result = localDateTime(new Date("2026-01-01T00:00:00Z"), "UTC");
    expect(result.date).toBe("2026-01-01");
    expect(result.time).toBe("00:00");
  });
});

describe("addDays", () => {
  it("adds one day", () => {
    expect(addDays("2026-03-15" as LocalDate, 1)).toBe("2026-03-16");
  });

  it("adds multiple days", () => {
    expect(addDays("2026-03-15" as LocalDate, 5)).toBe("2026-03-20");
  });

  it("adds across month boundary", () => {
    expect(addDays("2026-03-30" as LocalDate, 3)).toBe("2026-04-02");
  });

  it("adds across year boundary", () => {
    expect(addDays("2026-12-30" as LocalDate, 3)).toBe("2027-01-02");
  });

  it("subtracts days (negative)", () => {
    expect(addDays("2026-03-15" as LocalDate, -1)).toBe("2026-03-14");
  });

  it("subtracts across month boundary", () => {
    expect(addDays("2026-03-02" as LocalDate, -3)).toBe("2026-02-27");
  });

  it("returns same date for zero days", () => {
    expect(addDays("2026-03-15" as LocalDate, 0)).toBe("2026-03-15");
  });

  it("handles leap year February", () => {
    expect(addDays("2028-02-28" as LocalDate, 1)).toBe("2028-02-29");
  });

  it("handles non-leap year February", () => {
    expect(addDays("2026-02-28" as LocalDate, 1)).toBe("2026-03-01");
  });
});

describe("daysBetween", () => {
  it("returns 0 for same day", () => {
    expect(daysBetween("2026-03-15" as LocalDate, "2026-03-15" as LocalDate)).toBe(0);
  });

  it("returns positive for forward", () => {
    expect(daysBetween("2026-03-15" as LocalDate, "2026-03-20" as LocalDate)).toBe(5);
  });

  it("returns negative for backward", () => {
    expect(daysBetween("2026-03-20" as LocalDate, "2026-03-15" as LocalDate)).toBe(-5);
  });

  it("handles month boundary", () => {
    expect(daysBetween("2026-03-30" as LocalDate, "2026-04-02" as LocalDate)).toBe(3);
  });

  it("handles year boundary", () => {
    expect(daysBetween("2026-12-30" as LocalDate, "2027-01-02" as LocalDate)).toBe(3);
  });
});

describe("isLocalDate", () => {
  it("accepts a valid date", () => {
    expect(isLocalDate("2026-03-15")).toBe(true);
  });

  it("accepts a leap day", () => {
    expect(isLocalDate("2028-02-29")).toBe(true);
  });

  it("rejects a non-leap February 29", () => {
    expect(isLocalDate("2026-02-29")).toBe(false);
  });

  it("rejects wrong format (no dashes)", () => {
    expect(isLocalDate("20260315")).toBe(false);
  });

  it("rejects wrong format (slashes)", () => {
    expect(isLocalDate("2026/03/15")).toBe(false);
  });

  it("rejects too short", () => {
    expect(isLocalDate("2026-03-1")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isLocalDate("")).toBe(false);
  });

  it("rejects single digit month", () => {
    expect(isLocalDate("2026-3-15")).toBe(false);
  });

  it("rejects a date with a leading character", () => {
    expect(isLocalDate("x2026-01-15")).toBe(false);
  });

  it("rejects a date with a trailing character", () => {
    expect(isLocalDate("2026-01-15x")).toBe(false);
  });
});
