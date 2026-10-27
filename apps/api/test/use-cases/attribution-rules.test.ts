import type { Origin } from "@family-agenda/source-sdk";
import { openViewAccess, type Showing } from "@family-agenda/application";
import type { FamilyMemberId, SourceId, ViewId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";

const minutes = 60 * 1000;

/** A calendar entry creating an Event on Tuesday, from a sender, as a structured Source emits it. */
const entry = (key: string, sender: string | null, externalId = key): Origin => ({
  externalId,
  occurredAt: new Date("2026-09-01T10:00:00Z"),
  attributes: sender === null ? {} : { sender },
  content: {
    kind: "revisions",
    revisions: [
      {
        itemKind: "event",
        itemKey: key,
        action: "create",
        fields: { title: key, span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" } },
      },
    ],
  },
});

describe("Attribution Rules", () => {
  let instance: TestInstance;
  let source: SourceId;
  let mia: FamilyMemberId;
  let leo: FamilyMemberId;
  let view: ViewId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootForTest();
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "calendar" });
    await instance.restart();
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({
      sourceTypeId: "calendar",
      plain: { url: "https://calendar.example.org" },
      secrets: {},
    });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    source = added.id;
    const member = async (name: string) => {
      const result = await instance.app.familyMembers.add({ name });
      if (!result.ok) throw new Error(`adding failed: ${result.problem}`);
      return result.id;
    };
    mia = await member("Mia");
    leo = await member("Leo");
    const created = await instance.app.views.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    view = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The calendar emits the entries on its next run, and the worker runs it. */
  const arrive = async (...origins: Origin[]) => {
    testPluginControls.emit("calendar", origins);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
  };

  /** Tuesday's rows as title and whom they concern, by name, under the quick filter. */
  const tuesday = async (show: Showing = "all") => {
    const page = await instance.app.views.open(view, { access: openViewAccess, show });
    const names = new Map(page?.members.map((member) => [member.id, member.name]));
    const day = page?.days.find((candidate) => candidate.date === "2026-09-15");
    return (day?.items ?? []).map(
      (row) => `${row.title}: ${row.concerns === "whole-family" ? "Family" : row.concerns.map((id) => names.get(id)).join(", ")}`,
    );
  };

  it("lets an Item without a matching rule concern the whole Family, under every quick filter", async () => {
    await arrive(entry("Piano lesson", "Music school"));

    expect(await tuesday()).toEqual(["Piano lesson: Family"]);
    expect(await tuesday([mia])).toEqual(["Piano lesson: Family"]);
    expect(await tuesday([leo])).toEqual(["Piano lesson: Family"]);
  });

  /** Adds a rule for the calendar's senders, failing the test if it is refused. */
  const rule = async (value: string, concerns: FamilyMemberId[] | "whole-family") => {
    const result = await instance.app.attributionRules.create({ sourceId: source, attribute: "sender", value, concerns });
    if (!result.ok) throw new Error(`creating failed: ${result.problem}`);
    return result.id;
  };

  it("reattributes Items that came before a rule was added, and the quick filter hides them from others", async () => {
    await arrive(entry("Piano lesson", "Music school"), entry("Football", "Club"));

    await rule("Music school", [mia]);

    expect(await tuesday()).toEqual(["Football: Family", "Piano lesson: Mia"]);
    expect(await tuesday([mia]), "whole-Family Items show always").toEqual(["Football: Family", "Piano lesson: Mia"]);
    expect(await tuesday([leo])).toEqual(["Football: Family"]);
    expect(await tuesday([leo, mia])).toEqual(["Football: Family", "Piano lesson: Mia"]);
  });

  it("lets an Item whose Origins match different rules concern the union, the whole Family covering everyone", async () => {
    // The same match, once from the club's calendar entry and once from the school's.
    await arrive(entry("Match", "Club"), entry("Match", "School", "match-at-school"));
    await rule("Club", [leo]);
    await rule("School", [mia]);

    expect(await tuesday()).toEqual(["Match: Mia, Leo"]);

    await rule("Music school", [mia]);
    await arrive(entry("Match", "Music school", "match-at-music-school"));
    expect(await tuesday(), "a rule matching twice counts once").toEqual(["Match: Mia, Leo"]);

    await rule("Parents", "whole-family");
    await arrive(entry("Match", "Parents", "match-for-parents"));
    expect(await tuesday()).toEqual(["Match: Family"]);
    expect(await tuesday([leo])).toEqual(["Match: Family"]);
  });

  it("attributes Items anew when a rule is changed or removed", async () => {
    await arrive(entry("Piano lesson", "Music school"));
    const id = await rule("Music school", [mia]);

    expect(await instance.app.attributionRules.edit(id, { value: "Music school", concerns: [leo, mia] })).toEqual({ ok: true });
    expect(await tuesday()).toEqual(["Piano lesson: Mia, Leo"]);

    expect(await instance.app.attributionRules.edit(id, { value: "Other school", concerns: [leo] })).toEqual({ ok: true });
    expect(await tuesday()).toEqual(["Piano lesson: Family"]);

    await instance.app.attributionRules.edit(id, { value: "Music school", concerns: [leo] });
    await instance.app.attributionRules.remove(id);
    expect(await tuesday()).toEqual(["Piano lesson: Family"]);
    expect(await instance.app.attributionRules.list()).toEqual([]);
  });

  it("carries in a View's feed the Items concerning its preselected Family Members, and whole-Family ones", async () => {
    await arrive(entry("Piano lesson", "Music school"), entry("Football", "Club"), entry("Parents' evening", "School"));
    await rule("Music school", [mia]);
    await rule("Club", [leo]);
    const titles = async (preselected: FamilyMemberId[]) => {
      const created = await instance.app.views.create({ preselected, horizonDays: 7 });
      if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
      const feed = await instance.app.views.feed(created.id, { access: openViewAccess });
      return feed?.events.map((event) => event.title).sort();
    };

    expect(await titles([mia])).toEqual(["Parents' evening", "Piano lesson"]);
    expect(await titles([leo])).toEqual(["Football", "Parents' evening"]);
    expect(await titles([]), "a View preselecting no one carries everything").toEqual([
      "Football",
      "Parents' evening",
      "Piano lesson",
    ]);
  });

  it("lists rules with what they match and whom they concern, and forgets removed Family Members and Sources", async () => {
    await rule("Music school", [mia, leo]);
    await rule("Parents", "whole-family");

    expect(await instance.app.attributionRules.list()).toMatchObject([
      { sourceId: source, sourceName: "calendar", attribute: "sender", attributeLabel: "Sender", value: "Music school", concerns: [mia, leo] },
      { value: "Parents", concerns: "whole-family" },
    ]);

    await instance.app.familyMembers.remove(leo);
    expect((await instance.app.attributionRules.list()).map((listed) => listed.concerns)).toEqual([[mia], "whole-family"]);

    await instance.app.sources.remove(source);
    expect(await instance.app.attributionRules.list()).toEqual([]);
  });

  it("matches a value whatever its case, as a sender address is the same in any", async () => {
    await arrive(entry("Piano lesson", "teacher@school.example"));
    await rule("Teacher@School.example", [mia]);

    expect(await tuesday()).toEqual(["Piano lesson: Mia"]);
  });

  it("lets a rule left without anyone match nothing", async () => {
    await arrive(entry("Piano lesson", "Music school"));
    await rule("Music school", [leo]);
    await instance.app.familyMembers.remove(leo);

    expect(await tuesday()).toEqual(["Piano lesson: Family"]);
  });

  it("refuses a rule on an attribute the plugin does not declare, and rules it cannot apply", async () => {
    const create = (input: { attribute?: string; value?: string; concerns?: FamilyMemberId[] | "whole-family" }) =>
      instance.app.attributionRules.create({ sourceId: source, attribute: "sender", value: "Club", concerns: [mia], ...input });

    expect(await create({ attribute: "subject" })).toEqual({ ok: false, problem: "unknown-attribute" });
    expect(await instance.app.attributionRules.create({ sourceId: "nope" as SourceId, attribute: "sender", value: "Club", concerns: [mia] })).toEqual({
      ok: false,
      problem: "unknown-source",
    });
    expect(await create({ value: "  " })).toEqual({ ok: false, problem: "invalid-value" });
    expect(await create({ concerns: [] })).toEqual({ ok: false, problem: "no-one-concerned" });
    const stranger = "00000000-0000-4000-8000-000000000000" as FamilyMemberId;
    expect(await create({ concerns: [stranger] })).toEqual({
      ok: false,
      problem: "unknown-member",
    });
    expect(await create({ value: " Club " })).toMatchObject({ ok: true });
    expect(await create({}), "one rule per value").toEqual({ ok: false, problem: "rule-exists" });

    const other = await rule("School", [leo]);
    expect(await instance.app.attributionRules.edit(other, { value: "Club", concerns: [leo] })).toEqual({
      ok: false,
      problem: "rule-exists",
    });
  });

  it("offers the attribute values seen in the Source's Origins and those its plugin knows of", async () => {
    await arrive(entry("Piano lesson", "Music school"), entry("Football", "Club"), entry("Holiday", null));
    testPluginControls.knowValues("calendar", [
      { value: "teacher@school.example", label: "Ms Weber" },
      { value: "Club", label: "Football club" },
    ]);

    expect(await instance.app.attributionRules.targets()).toMatchObject([
      { sourceId: source, sourceName: "calendar", sourcePlain: { url: "https://calendar.example.org" }, attribute: "sender" },
    ]);
    const form = await instance.app.attributionRules.form(source, "sender");
    expect(form?.knownValues).toEqual([
      { value: "Club", label: "Football club" },
      { value: "teacher@school.example", label: "Ms Weber" },
      { value: "Music school", label: "Music school" },
    ]);
    expect(await instance.app.attributionRules.form(source, "subject")).toBeNull();

    testPluginControls.knowValues("calendar", "fail");
    expect((await instance.app.attributionRules.form(source, "sender"))?.knownValues.map((known) => known.value), "the seen ones still").toEqual([
      "Club",
      "Music school",
    ]);
  });
});
