import type { Event, LocalDate } from "@family-agenda/domain";
import { describe, expect, it } from "vitest";
import { isLongOver, wasOverOnArrival } from "../src/past-items";

const berlin = "Europe/Berlin";
const day = (date: string) => date as LocalDate;

const event = (span: Event["span"]) => ({ kind: "event" as const, event: { title: "Parents' evening", span, place: null, cancelled: false } });
const allDay = (first: string, last: string) => event({ allDay: true, firstDay: day(first), lastDay: day(last) });
const timed = (start: string, end: string) => event({ allDay: false, start: new Date(start), end: new Date(end) });
const task = (deadline: string | null) => ({
  kind: "task" as const,
  task: { title: "Pay", deadline: deadline === null ? null : day(deadline), description: null, cancelled: false },
});

describe("whether what a message states was over when it arrived", () => {
  const over = (item: Parameters<typeof wasOverOnArrival>[0]) => wasOverOnArrival(item, day("2026-11-24"), berlin);

  it("is an Event that ended the day before, but not one of that day or later", () => {
    expect(over(allDay("2026-11-23", "2026-11-23"))).toBe(true);
    expect(over(allDay("2026-11-24", "2026-11-24"))).toBe(false);
    expect(over(allDay("2026-11-25", "2026-11-25"))).toBe(false);
  });

  it("is not an Event over several days that still lasts", () => {
    expect(over(allDay("2026-11-20", "2026-11-24"))).toBe(false);
  });

  it("goes by the Family's time zone", () => {
    expect(over(timed("2026-11-23T20:00:00Z", "2026-11-23T22:30:00Z"))).toBe(true);
    expect(over(timed("2026-11-23T22:00:00Z", "2026-11-23T23:30:00Z"))).toBe(false);
  });

  it("is a Task whose Deadline passed, but never one without a Deadline", () => {
    expect(over(task("2026-11-23"))).toBe(true);
    expect(over(task("2026-11-24"))).toBe(false);
    expect(over(task(null))).toBe(false);
  });
});

describe("whether a stated Item is long over", () => {
  const longOver = (item: Parameters<typeof isLongOver>[0]) => isLongOver(item, day("2026-11-24"), berlin);

  it("is an Event that ended more than 30 days ago", () => {
    expect(longOver(allDay("2026-10-24", "2026-10-24"))).toBe(true);
    expect(longOver(allDay("2026-10-25", "2026-10-25"))).toBe(false);
    expect(longOver(allDay("2026-10-01", "2026-10-25"))).toBe(false);
  });

  it("is never a Task", () => {
    expect(longOver(task("2026-01-01"))).toBe(false);
  });
});
