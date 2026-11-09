import type { Origin, StatedLesson } from "../support/test-source-plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignSource } from "../support/assign";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";
import { testPluginControls } from "../support/test-source-plugin";

/** Berlin is two hours ahead of UTC in September. */
const at = (from: string, until: string) => ({
  allDay: false as const,
  start: new Date(`2026-09-15T${from}:00+02:00`).toISOString(),
  end: new Date(`2026-09-15T${until}:00+02:00`).toISOString(),
});

/** A period of Tuesday's Timetable, its Lesson stated whole with how it deviates from the Timetable. */
const period = (key: string, subject: string, span: ReturnType<typeof at>, room: string, teacher: string, deviation: Partial<StatedLesson> = {}): Origin => ({
  externalId: key,
  attributes: ["main"],
  content: {
    kind: "stated",
    stated: { kind: "lesson", subject, span, room, teacher, change: null, previousRoom: null, previousTeacher: null, note: null, ...deviation },
  },
});

describe("Timetables in an Agenda over HTTP", () => {
  let instance: HttpTestInstance;
  let path: string;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "untis-test", displayName: "Untis" }] });
    await instance.post("/setup", { email: "anna@example.org", password: "correct horse battery" });
    await instance.app.sourceTypes.enable("untis-test");
    const added = await instance.app.sources.add({ sourceTypeId: "untis-test", plain: { url: "https://school.example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    const mia = await instance.app.familyMembers.add({ name: "Mia" });
    if (!mia.ok) throw new Error("adding failed");
    await assignSource(instance, added.id, [mia.id]);
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    path = `/agendas/${created.id}`;
    testPluginControls.emit("untis-test", [
      period("maths", "Maths", at("08:00", "08:45"), "101", "Mr Brandt"),
      period("english", "English", at("08:50", "09:35"), "102", "Ms Weber", { change: "substitution", previousTeacher: "Mr Roth" }),
      period("physics", "Physics", at("09:55", "10:40"), "Lab", "Ms Lang", { change: "cancellation", note: "Teacher ill" }),
    ]);
    // Assigning the Source ran it once already.
    instance.clock.advance(15 * 60 * 1000);
    await instance.app.polling.pollDue();
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The row whose summary holds the given text, from `<details>` to `</details>`. */
  const rowOf = (page: string, text: string) =>
    new RegExp(`<details[^>]*>\\s*<summary>(?:(?!</summary>).)*${text}(?:(?!</details>).)*</details>`, "s").exec(page)?.[0] ?? "";

  it("collapses the school day into one row, until its last Lesson that takes place, that lists its Lessons on tap", async () => {
    const page = await (await instance.get(path)).text();

    const school = rowOf(page, "School until 09:35");
    expect(school).toMatch(/<summary>.*08:00.*School until 09:35.*<\/summary>/s);
    expect(school).toMatch(/08:00 – 08:45.*Maths.*101.*Mr Brandt/s);
    expect(school).toMatch(/08:50 – 09:35.*English.*102.*Ms Weber/s);
    expect(school).toMatch(/<s>Physics<\/s>/);
    expect(page).not.toMatch(/<summary>(?:(?!<\/summary>).)*Maths(?:(?!<\/summary>).)*<\/summary>/s);
  });

  it("marks what runs today: the Lesson and the school day, and the Timetable Change that is no cancellation", async () => {
    instance.clock.advance(24 * 60 * 60 * 1000);

    const page = await (await instance.get(path)).text();

    const school = rowOf(page, "School until 09:35");
    expect(school).toMatch(/^<details class="fam-event fam-event--school fam-event--now"/);
    expect(school.match(/fam-lesson--now/g)).toHaveLength(1);
    expect(school).toMatch(/fam-lesson--now" aria-current="time">\s*<span class="fam-lesson__time">\s*<span class="fam-running">Now<\/span>\s*08:50 – 09:35/);
    expect(rowOf(page, "English: substituted by Ms Weber")).toMatch(/^<details class="fam-event fam-event--change fam-event--now"/);
    expect(rowOf(page, "Physics: cancelled")).not.toContain("fam-event--now");
  });

  it("marks nothing of a school day that is not on", async () => {
    const page = await (await instance.get(path)).text();

    expect(page).not.toContain("--now");
  });

  it("shows each Timetable Change as its own highlighted row", async () => {
    const page = await (await instance.get(path)).text();

    const cancelled = rowOf(page, "Physics: cancelled");
    expect(cancelled).toMatch(/^<details class="fam-event fam-event--change"/);
    expect(cancelled).toMatch(/<summary>.*09:55 – 10:40.*Physics: cancelled.*<\/summary>/s);
    expect(cancelled).toContain("Teacher ill");
    const substituted = rowOf(page, "English: substituted by Ms Weber");
    expect(substituted).toMatch(/^<details class="fam-event fam-event--change"/);
    expect(substituted).toContain("instead of Mr Roth");
  });

  it("says it in German in a German Family", async () => {
    await instance.app.languages.setLanguage("de");

    const page = await (await instance.get(path)).text();

    expect(page).toContain("Schule bis 09:35");
    expect(page).toContain("Physics: entfällt");
  });
});
