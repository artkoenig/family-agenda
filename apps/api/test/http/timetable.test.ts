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
      period("maths", "Maths", at("08:00", "08:45"), "101", "Mr Brandt", { note: "Bring the atlas" }),
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

  it("marks what runs today: the Lesson and the school day", async () => {
    instance.clock.advance(24 * 60 * 60 * 1000);

    const page = await (await instance.get(path)).text();

    const school = rowOf(page, "School until 09:35");
    expect(school).toMatch(/^<details class="fam-event fam-event--school fam-event--now"/);
    expect(school.match(/fam-lesson--now/g)).toHaveLength(1);
    expect(school).toMatch(/fam-lesson--now" aria-current="time">\s*<span class="fam-lesson__time">\s*<span class="fam-running">Now<\/span>\s*08:50 – 09:35/);
  });

  it("marks nothing of a school day that is not on", async () => {
    const page = await (await instance.get(path)).text();

    expect(page).not.toContain("--now");
  });

  it("says the day's Timetable Changes and notes beneath the school day, and lists the notes after its Lessons", async () => {
    const page = await (await instance.get(path)).text();

    const school = rowOf(page, "School until 09:35");
    expect(school).toMatch(/<summary>.*<span aria-hidden="true">⚠ <\/span>\s*Physics cancelled · Substitution in English · 2 notes.*<\/summary>/s);
    expect(school).toMatch(/English<\/span>\s*<span class="fam-lesson__where">102 · substituted by Ms Weber<\/span>/);
    expect(school).toMatch(/<dt>Maths<\/dt>\s*<dd>Bring the atlas<\/dd>\s*<dt>Physics<\/dt>\s*<dd>Teacher ill<\/dd>/);
    expect(page).not.toContain("fam-event--change");
  });

  it("says only the notes beneath a school day without Timetable Changes, and lists a double period as one", async () => {
    testPluginControls.withdraw("untis-test", ["english", "physics"], [
      period("maths", "Maths", at("08:00", "08:45"), "101", "Mr Brandt", { note: "Bring the atlas" }),
      period("maths-2", "Maths", at("08:45", "09:30"), "101", "Mr Brandt", { note: "Bring the atlas" }),
    ]);
    instance.clock.advance(30 * 60 * 1000);
    await instance.app.polling.pollDue();

    const school = rowOf(await (await instance.get(path)).text(), "School until 09:30");
    expect(school).toMatch(/<span class="fam-item__meta">\s*1 note<\/span>/);
    expect(school).not.toContain("⚠");
    expect(school.match(/class="fam-lesson"/g)).toHaveLength(1);
    expect(school).toMatch(/08:00 – 09:30/);
  });

  it("says it in German in a German Family", async () => {
    await instance.app.languages.setLanguage("de");

    const page = await (await instance.get(path)).text();

    expect(page).toContain("Schule bis 09:35");
    expect(page).toContain("Physics fällt aus · Vertretung in English · 2 Hinweise");
  });
});
