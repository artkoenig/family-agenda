import { describe, expect, it } from "vitest";
import {
  dayOfTask,
  instantOfTask,
  isOutstanding,
  isPinned,
  maximumTaskTextLength,
  maximumThingsToBring,
  problemsWithTaskRevision,
  taskOf,
  taskStatus,
  type Act,
  type ItemFields,
  type LocalDate,
  type Task,
} from "../src";

const day = (date: string) => date as LocalDate;
const at = (iso: string) => new Date(iso);

const task = (overrides: Partial<Task> = {}): Task => ({
  title: "Bring milk",
  deadline: null,
  bring: ["milk"],
  doneAt: null,
  arrivedAt: at("2026-09-10T10:00:00Z"),
  cancelled: false,
  ...overrides,
});

describe("a Task Revision", () => {
  it.each([
    {
      case: "a create with all fields",
      act: "create" as Act,
      fields: { title: "Bring milk", deadline: "2026-09-15", bring: ["milk", "juice"] },
      problems: [],
    },
    {
      case: "a create without a title",
      act: "create" as Act,
      fields: { deadline: "2026-09-15" },
      problems: ["title is missing"],
    },
    {
      case: "a move without a deadline",
      act: "move" as Act,
      fields: { title: "Bring milk" },
      problems: ["deadline is missing"],
    },
    {
      case: "a cancel with no fields",
      act: "cancel" as Act,
      fields: {},
      problems: [],
    },
    {
      case: "an empty title",
      act: "change" as Act,
      fields: { title: "   " },
      problems: ["title is not a non-empty text"],
    },
    {
      case: "a title that is too long",
      act: "change" as Act,
      fields: { title: "x".repeat(maximumTaskTextLength + 1) },
      problems: ["title is not a non-empty text"],
    },
    {
      case: "a title at the maximum length",
      act: "change" as Act,
      fields: { title: "x".repeat(maximumTaskTextLength) },
      problems: [],
    },
    {
      case: "a title that is not a string",
      act: "change" as Act,
      fields: { title: 42 },
      problems: ["title is not a non-empty text"],
    },
    {
      case: "a deadline that is not a date",
      act: "change" as Act,
      fields: { deadline: "15-09-2026" },
      problems: ["deadline is not a date or null"],
    },
    {
      case: "a deadline that is a real but impossible date",
      act: "change" as Act,
      fields: { deadline: "2026-02-30" },
      problems: ["deadline is not a date or null"],
    },
    {
      case: "a deadline of null is fine",
      act: "change" as Act,
      fields: { deadline: null },
      problems: [],
    },
    {
      case: "a bring that is not an array",
      act: "change" as Act,
      fields: { bring: "milk" },
      problems: [`bring is not a list of at most ${maximumThingsToBring} non-empty texts`],
    },
    {
      case: "a bring with more than the maximum",
      act: "change" as Act,
      fields: { bring: Array.from({ length: maximumThingsToBring + 1 }, (_, i) => `item ${i}`) },
      problems: [`bring is not a list of at most ${maximumThingsToBring} non-empty texts`],
    },
    {
      case: "a bring at the maximum is fine",
      act: "change" as Act,
      fields: { bring: Array.from({ length: maximumThingsToBring }, (_, i) => `item ${i}`) },
      problems: [],
    },
    {
      case: "a bring with an empty string",
      act: "change" as Act,
      fields: { bring: ["milk", ""] },
      problems: [`bring is not a list of at most ${maximumThingsToBring} non-empty texts`],
    },
    {
      case: "a bring with a non-string",
      act: "change" as Act,
      fields: { bring: ["milk", 42] },
      problems: [`bring is not a list of at most ${maximumThingsToBring} non-empty texts`],
    },
    {
      case: "a bring with a too-long text",
      act: "change" as Act,
      fields: { bring: ["milk", "x".repeat(maximumTaskTextLength + 1)] },
      problems: [`bring is not a list of at most ${maximumThingsToBring} non-empty texts`],
    },
    {
      case: "an unknown field",
      act: "change" as Act,
      fields: { colour: "red" },
      problems: ["colour is not a field of a Task"],
    },
    {
      case: "multiple problems",
      act: "create" as Act,
      fields: { deadline: "bad", bring: [], colour: "red" },
      problems: ["title is missing", "deadline is not a date or null", "colour is not a field of a Task"],
    },
  ])("$case", ({ act, fields, problems }) => {
    expect(problemsWithTaskRevision(act, fields)).toEqual(problems);
  });

  it("does not report a missing deadline when deadline is present", () => {
    const problems = problemsWithTaskRevision("move", { deadline: "2026-01-15" });
    expect(problems).not.toContain("deadline is missing");
  });

  it("reports a missing deadline when it is absent from a move", () => {
    const problems = problemsWithTaskRevision("move", {});
    expect(problems).toContain("deadline is missing");
  });
});

describe("taskOf", () => {
  const folded = (fields: Record<string, unknown>, more: Partial<ItemFields> = {}): ItemFields => ({
    fields,
    cancelled: false,
    ...more,
  });

  it("returns the Task its fields describe", () => {
    const result = taskOf(folded({ title: "Bring milk", deadline: "2026-09-15", bring: ["milk", "juice"] }));
    expect(result).toEqual({ title: "Bring milk", deadline: day("2026-09-15"), bring: ["milk", "juice"], cancelled: false });
  });

  it("returns null when there is no folded Item", () => {
    expect(taskOf(null)).toBeNull();
  });

  it("returns null while it has no title", () => {
    expect(taskOf(folded({ deadline: "2026-09-15" }))).toBeNull();
  });

  it("returns null when the title is empty", () => {
    expect(taskOf(folded({ title: "  " }))).toBeNull();
  });

  it("parses a null deadline and missing bring", () => {
    const result = taskOf(folded({ title: "Bring milk" }));
    expect(result).toEqual({
      title: "Bring milk",
      deadline: null,
      bring: [],
      cancelled: false,
    });
  });

  it("keeps the cancelled flag", () => {
    const result = taskOf(folded({ title: "Bring milk" }, { cancelled: true }));
    expect(result?.cancelled).toBe(true);
  });

});

describe("taskStatus", () => {
  const today = day("2026-09-15");

  it.each([
    { case: "done", task: task({ doneAt: at("2026-09-15T12:00:00Z") }), status: "done" },
    { case: "due, no deadline", task: task({ deadline: null }), status: "due" },
    { case: "due, deadline is today", task: task({ deadline: day("2026-09-15") }), status: "due" },
    { case: "overdue, deadline was yesterday", task: task({ deadline: day("2026-09-14") }), status: "overdue" },
    { case: "upcoming, deadline is tomorrow", task: task({ deadline: day("2026-09-16") }), status: "upcoming" },
  ])("$case → $status", ({ task, status }) => {
    expect(taskStatus(task, today)).toBe(status);
  });
});

describe("isPinned", () => {
  const today = day("2026-09-15");

  it.each([
    { case: "due", task: task({ deadline: null }), pinned: true },
    { case: "due, deadline today", task: task({ deadline: day("2026-09-15") }), pinned: true },
    { case: "overdue", task: task({ deadline: day("2026-09-14") }), pinned: true },
    { case: "upcoming", task: task({ deadline: day("2026-09-16") }), pinned: false },
    { case: "done", task: task({ doneAt: at("2026-09-15T12:00:00Z") }), pinned: false },
    { case: "cancelled but due", task: task({ deadline: null, cancelled: true }), pinned: true },
  ])("$case → $pinned", ({ task, pinned }) => {
    expect(isPinned(task, today)).toBe(pinned);
  });
});

describe("instantOfTask", () => {
  it("returns the arrival instant for a done Task without a Deadline", () => {
    const t = task({ deadline: null, doneAt: at("2026-09-15T12:00:00Z"), arrivedAt: at("2026-09-10T10:00:00Z") });
    expect(instantOfTask(t)).toEqual(at("2026-09-10T10:00:00Z"));
  });

  it("falls back to the tick when the Task was stored before its arrival was kept", () => {
    const t = task({ deadline: null, doneAt: at("2026-09-15T12:00:00Z"), arrivedAt: null });
    expect(instantOfTask(t)).toEqual(at("2026-09-15T12:00:00Z"));
  });

  it("returns null while it is not done", () => {
    const t = task({ deadline: null, doneAt: null });
    expect(instantOfTask(t)).toBeNull();
  });

  it("returns null when it has a Deadline", () => {
    const t = task({ deadline: day("2026-09-15"), doneAt: at("2026-09-15T12:00:00Z") });
    expect(instantOfTask(t)).toBeNull();
  });
});

describe("dayOfTask", () => {
  it("returns the Deadline day", () => {
    const t = task({ deadline: day("2026-09-15") });
    expect(dayOfTask(t, "Europe/Berlin")).toBe(day("2026-09-15"));
  });

  it("returns the arrival day for a done Task without a Deadline", () => {
    const t = task({ deadline: null, doneAt: at("2026-09-15T12:00:00Z"), arrivedAt: at("2026-09-10T10:00:00Z") });
    expect(dayOfTask(t, "Europe/Berlin")).toBe(day("2026-09-10"));
  });

  it("returns null when it is neither", () => {
    const t = task({ deadline: null, doneAt: null });
    expect(dayOfTask(t, "Europe/Berlin")).toBeNull();
  });
});

describe("isOutstanding", () => {
  it("is true while it is not done", () => {
    expect(isOutstanding(task({ doneAt: null }))).toBe(true);
  });
  it("is false once it is done", () => {
    expect(isOutstanding(task({ doneAt: at("2026-09-15T12:00:00Z") }))).toBe(false);
  });
});
