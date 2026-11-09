import type { Origin } from "../support/test-source-plugin";
import { openAgendaAccess, type Showing } from "@family-agenda/application";
import type { FamilyMemberId, SourceAttributeId, SourceId, AgendaId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignSource } from "../support/assign";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls } from "../support/test-source-plugin";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

/** A calendar entry creating an Event on Tuesday, under the Source Attributes given, as a structured Source emits it. */
const entry = (key: string, attributes = ["main"]): Origin => ({
  externalId: key,
  attributes,
  content: { kind: "stated", stated: { kind: "event", title: key, span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" }, place: null, cancelled: false } },
});

describe("Attribution by Source Attribute", () => {
  let instance: TestInstance;
  let calendar: SourceId;
  let club: SourceId;
  let mia: FamilyMemberId;
  let leo: FamilyMemberId;
  let agenda: AgendaId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootForTest();
    await instance.installPlugin({ sourceTypeId: "calendar" });
    await instance.installPlugin({ sourceTypeId: "club" });
    await instance.restart();
    const source = async (sourceTypeId: string) => {
      await instance.app.sourceTypes.enable(sourceTypeId);
      const added = await instance.app.sources.add({ sourceTypeId, plain: { url: "https://calendar.example.org" }, secrets: {} });
      if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
      return added.id;
    };
    calendar = await source("calendar");
    club = await source("club");
    const member = async (name: string) => {
      const result = await instance.app.familyMembers.add({ name });
      if (!result.ok) throw new Error(`adding failed: ${result.problem}`);
      return result.id;
    };
    mia = await member("Mia");
    leo = await member("Leo");
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    agenda = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The Sources emit the entries on their next run, and the worker runs them. */
  const arrive = async (origins: { calendar?: Origin[]; club?: Origin[] }) => {
    testPluginControls.emit("calendar", origins.calendar ?? []);
    testPluginControls.emit("club", origins.club ?? []);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
  };

  /** Tuesday's rows as title and whom they concern, by name, under the quick filter. */
  const tuesday = async (show: Showing = "all") => {
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess, show });
    const names = new Map(page?.members.map((member) => [member.id, member.name]));
    const day = page?.days.find((candidate) => candidate.date === "2026-09-15");
    return (day?.items ?? []).map(
      (row) => `${row.title}: ${row.concerns === "whole-family" ? "Family" : row.concerns.map((id) => names.get(id)).join(", ")}`,
    );
  };

  /** The Source Attributes of a Source, by name. */
  const attributesOf = async (source: SourceId) => (await instance.app.sources.list()).find((listed) => listed.id === source)?.attributes ?? [];

  /** Assigns the Source Attribute named to the Family Members, failing the test if it is refused. */
  const assign = async (source: SourceId, name: string, members: FamilyMemberId[]) => {
    const attribute = (await attributesOf(source)).find((candidate) => candidate.name === name);
    if (!attribute) throw new Error(`no Source Attribute ${name}`);
    const result = await instance.app.sources.assignAttribute(attribute.id, members);
    if (!result.ok) throw new Error(`assigning failed: ${result.problem}`);
  };

  it("lets the Items of a Source Attribute assigned to no one concern the whole Family, shown only without a quick filter", async () => {
    await arrive({ calendar: [entry("Piano lesson")] });

    expect(await tuesday()).toEqual(["Piano lesson: Family"]);
    expect(await tuesday([mia])).toEqual([]);
    expect(await tuesday([leo])).toEqual([]);
  });

  it("attributes the Items that came before their Source Attribute was assigned", async () => {
    await arrive({ calendar: [entry("Piano lesson", ["music"]), entry("Holiday", ["school"])], club: [entry("Football")] });

    await assign(calendar, "music", [mia]);
    await assign(calendar, "school", [leo]);

    expect(await tuesday()).toEqual(["Football: Family", "Holiday: Leo", "Piano lesson: Mia"]);
    expect(await tuesday([mia]), "whole-Family Items are not shown to chosen members").toEqual(["Piano lesson: Mia"]);
    expect(await tuesday([leo])).toEqual(["Holiday: Leo"]);
  });

  it("attributes Items anew when a Source Attribute is assigned to others or to no one", async () => {
    await arrive({ calendar: [entry("Piano lesson")] });
    await assign(calendar, "main", [leo, mia]);
    expect(await tuesday(), "in the Family's order").toEqual(["Piano lesson: Mia, Leo"]);

    await assign(calendar, "main", [leo]);
    expect(await tuesday()).toEqual(["Piano lesson: Leo"]);

    await assign(calendar, "main", []);
    expect(await tuesday()).toEqual(["Piano lesson: Family"]);
  });

  it("lets an Item under several Source Attributes concern all they are assigned to, or the whole Family if one is assigned to no one", async () => {
    await arrive({ calendar: [entry("Class trip", ["school", "club"])] });
    await assign(calendar, "school", [mia]);
    await assign(calendar, "club", [leo]);
    expect(await tuesday()).toEqual(["Class trip: Mia, Leo"]);

    await assign(calendar, "club", []);
    expect(await tuesday()).toEqual(["Class trip: Family"]);
  });

  it("carries in an Agenda's feed the Items concerning its members, not the whole-Family ones", async () => {
    await arrive({ calendar: [entry("Piano lesson")], club: [entry("Football")] });
    await assign(calendar, "main", [mia]);
    const titles = async (memberIds: FamilyMemberId[]) => {
      const created = await instance.app.agendas.create({ memberIds, horizonDays: 7 });
      if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
      const feed = await instance.app.agendas.feed(created.id, { access: openAgendaAccess });
      return feed?.events.map((event) => event.title).sort();
    };

    expect(await titles([mia])).toEqual(["Piano lesson"]);
    expect(await titles([leo])).toEqual([]);
    expect(await titles([])).toEqual(["Football", "Piano lesson"]);
    await assign(club, "main", [leo]);
    expect(await titles([leo])).toEqual(["Football"]);
  });

  it("lists a Source with its Source Attributes and whom each concerns, forgets removed Family Members, and keeps the one who is alone on a Source Attribute", async () => {
    await arrive({ calendar: [entry("Piano lesson", ["music", "school"])] });
    await assign(calendar, "music", [leo, mia]);
    const concerns = async () => (await attributesOf(calendar)).map(({ name, concerns }) => [name, concerns]);

    expect(await concerns(), "in the Family's order, by name").toEqual([["music", [mia, leo]], ["school", []]]);

    await instance.app.familyMembers.remove(mia);
    expect(await concerns()).toEqual([["music", [leo]], ["school", []]]);
    expect(await instance.app.familyMembers.remove(leo), "a Source Attribute never silently widens to the whole Family").toMatchObject({ ok: false, problem: "sole-assignee" });
    expect(await concerns()).toEqual([["music", [leo]], ["school", []]]);
    await assign(calendar, "music", []);
    expect(await instance.app.familyMembers.remove(leo)).toEqual({ ok: true });
  });

  it("refuses to assign an unknown Source Attribute or Family Member", async () => {
    await arrive({ calendar: [entry("Piano lesson")] });
    const stranger = "00000000-0000-4000-8000-000000000000" as FamilyMemberId;
    const [attribute] = await attributesOf(calendar);

    expect(await instance.app.sources.assignAttribute(attribute!.id, [mia, stranger])).toEqual({ ok: false, problem: "unknown-member" });
    expect(await instance.app.sources.assignAttribute("nope" as SourceAttributeId, [mia])).toEqual({ ok: false, problem: "unknown-attribute" });
    expect((await attributesOf(calendar))[0]?.concerns).toEqual([]);
  });

  it("lets a Source that has not run yet be assigned once it declares", async () => {
    await assignSource(instance, club, [leo]);
    await arrive({ club: [entry("Football")] });

    expect(await tuesday()).toEqual(["Football: Leo"]);
  });
});
