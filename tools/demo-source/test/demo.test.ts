import { describe, expect, it } from "vitest";
import type { IngestResult, SourceRecord } from "@family-agenda/plugin-contract";
import { demoPlugin } from "../src/plugin";

type StatedItem = Extract<SourceRecord["content"], { kind: "stated" }>["stated"];

const config = { plain: {}, secrets: {} };
// A Monday morning.
const now = new Date("2026-09-14T07:00:00Z");

const poll = async (day: Date = now): Promise<IngestResult & { origins: SourceRecord[] }> => {
  const result = (await demoPlugin.poll?.({ config, syncCursor: null, now: day.toISOString(), timeZone: "Europe/Berlin" })) as IngestResult;
  return { ...result, origins: result.sourceRecords };
};

const statedItems = (origins: SourceRecord[]): StatedItem[] => origins.flatMap((origin) => (origin.content.kind === "stated" ? [origin.content.stated] : []));

describe("the demo plugin", () => {
  it("states Events, Lessons and Tasks, so every kind of Agenda has something to show", async () => {
    const { origins } = await poll();

    const kinds = new Set(statedItems(origins).map((item) => item.kind));
    expect([...kinds].sort()).toEqual(["event", "lesson", "task"]);
  });

  it("states its Tasks under one id each, with Deadlines ahead of the run, so they never pile up as Overdue", async () => {
    const tasksOn = async (day: Date) =>
      (await poll(day)).origins.flatMap((origin) => (origin.content.kind === "stated" && origin.content.stated.kind === "task" ? [{ id: origin.externalId, ...origin.content.stated }] : []));

    const monday = await tasksOn(now);
    const later = await tasksOn(new Date("2026-10-05T07:00:00Z"));

    expect(monday).toEqual([
      { id: "task-class-trip-form", kind: "task", title: "Sign the class trip form", deadline: "2026-09-15", bring: [] },
      { id: "task-swimming-kit", kind: "task", title: "Bring the swimming kit", deadline: "2026-09-17", bring: ["Swimsuit", "Towel", "Goggles"] },
    ]);
    expect(later.map((task) => [task.id, task.deadline])).toEqual([["task-class-trip-form", "2026-10-06"], ["task-swimming-kit", "2026-10-08"]]);
  });

  it("starts on the day of the run, in the Family's time zone", async () => {
    const { origins } = await poll();

    const firstLesson = origins.find((origin) => origin.externalId === "lesson-2026-09-14-1");
    // 08:00 in Berlin, which is two hours ahead of UTC in September.
    expect(firstLesson?.content).toMatchObject({ stated: { kind: "lesson", subject: "Mathematics", span: { start: "2026-09-14T06:00:00.000Z", end: "2026-09-14T06:45:00.000Z" } } });
  });

  it("follows the date of the run, so an Agenda is never empty", async () => {
    const { origins } = await poll(new Date("2027-01-06T07:00:00Z"));

    // Winter time: 08:00 in Berlin is 07:00 UTC. The 6th of January 2027 is a Wednesday, so its first lesson is substituted.
    expect(origins.find((origin) => origin.externalId === "lesson-2027-01-06-1")?.content).toMatchObject({
      stated: { span: { start: "2027-01-06T07:00:00.000Z" }, change: "substitution", teacher: "Mr Braun", previousTeacher: "Ms Weber" },
    });
    expect(origins.some((origin) => origin.externalId.includes("2026-09"))).toBe(false);
  });

  it("states the same Origins when it runs again, so a re-run changes nothing", async () => {
    const first = await poll();
    const second = await poll();

    expect(second.origins).toEqual(first.origins);
    expect(new Set(first.origins.map((origin) => origin.externalId)).size).toBe(first.origins.length);
  });

  it("declares every Source Attribute its Origins name", async () => {
    const { origins, attributes } = await poll();

    const declared = new Set(attributes?.declared.map((attribute) => attribute.externalId));
    expect(origins.flatMap((origin) => origin.attributes).filter((id) => !declared.has(id))).toEqual([]);
  });
});
