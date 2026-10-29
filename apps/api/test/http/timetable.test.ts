import type { Origin, PluginRevision } from "@family-agenda/source-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";
import { testPluginControls } from "../support/test-source-plugin";

/** Berlin is two hours ahead of UTC in September. */
const at = (from: string, until: string) => ({
  allDay: false,
  start: new Date(`2026-09-15T${from}:00+02:00`).toISOString(),
  end: new Date(`2026-09-15T${until}:00+02:00`).toISOString(),
});

/** A period of Tuesday's Timetable, its Lesson keyed by `key` and its Timetable Change by `key/change`. */
const period = (key: string, revisions: Omit<PluginRevision, "itemKey">[]): Origin => ({
  externalId: key,
  occurredAt: new Date("2026-09-14T07:00:00Z"),
  attributes: {},
  content: {
    kind: "revisions",
    revisions: revisions.map((revision) => ({ ...revision, itemKey: revision.itemKind === "lesson" ? key : `${key}/change` })),
  },
});

const lesson = (subject: string, span: ReturnType<typeof at>, room: string, teacher: string) =>
  ({ itemKind: "lesson", action: "create", fields: { subject, span, room, teacher } }) as const;

const change = (fields: PluginRevision["fields"]): Omit<PluginRevision, "itemKey"> => ({
  itemKind: "timetable-change",
  action: "create",
  fields: { room: null, teacher: null, previousRoom: null, previousTeacher: null, note: null, ...fields },
});

describe("Timetables in a View over HTTP", () => {
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
    await instance.app.sources.assign(added.id, [mia.id]);
    const created = await instance.app.views.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    path = `/views/${created.id}`;
    testPluginControls.emit("untis-test", [
      period("maths", [lesson("Maths", at("08:00", "08:45"), "101", "Mr Brandt")]),
      period("english", [
        lesson("English", at("08:50", "09:35"), "102", "Ms Weber"),
        change({ change: "substitution", subject: "English", span: at("08:50", "09:35"), teacher: "Ms Weber", previousTeacher: "Mr Roth" }),
      ]),
      period("physics", [
        lesson("Physics", at("09:55", "10:40"), "Lab", "Ms Lang"),
        { itemKind: "lesson", action: "cancel", fields: {} },
        change({ change: "cancellation", subject: "Physics", span: at("09:55", "10:40"), note: "Teacher ill" }),
      ]),
    ]);
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
