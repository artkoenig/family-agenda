import type { Origin } from "@family-agenda/source-sdk";
import { openViewAccess, type Showing } from "@family-agenda/application";
import type { FamilyMemberId, SourceId, ViewId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

/** A calendar entry creating an Event on Tuesday, from a sender, as a structured Source emits it. */
const entry = (key: string, sender = "Music school"): Origin => ({
  externalId: key,
  occurredAt: new Date("2026-09-01T10:00:00Z"),
  attributes: { sender },
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

describe("Attribution by Source", () => {
  let instance: TestInstance;
  let calendar: SourceId;
  let club: SourceId;
  let mia: FamilyMemberId;
  let leo: FamilyMemberId;
  let view: ViewId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootForTest();
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "calendar" });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "club" });
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
    const created = await instance.app.views.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    view = created.id;
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
    const page = await openTimeline(instance.app, view, { access: openViewAccess, show });
    const names = new Map(page?.members.map((member) => [member.id, member.name]));
    const day = page?.days.find((candidate) => candidate.date === "2026-09-15");
    return (day?.items ?? []).map(
      (row) => `${row.title}: ${row.concerns === "whole-family" ? "Family" : row.concerns.map((id) => names.get(id)).join(", ")}`,
    );
  };

  /** Assigns the Source to the Family Members, failing the test if it is refused. */
  const assign = async (source: SourceId, members: FamilyMemberId[]) => {
    const result = await instance.app.sources.assign(source, members);
    if (!result.ok) throw new Error(`assigning failed: ${result.problem}`);
  };

  it("lets the Items of a Source assigned to no one concern the whole Family, under every quick filter", async () => {
    await arrive({ calendar: [entry("Piano lesson")] });

    expect(await tuesday()).toEqual(["Piano lesson: Family"]);
    expect(await tuesday([mia])).toEqual(["Piano lesson: Family"]);
    expect(await tuesday([leo])).toEqual(["Piano lesson: Family"]);
  });

  it("attributes the Items that came before a Source was assigned, whatever their Origins say", async () => {
    await arrive({ calendar: [entry("Piano lesson", "Music school"), entry("Holiday", "School")], club: [entry("Football")] });

    await assign(calendar, [mia]);

    expect(await tuesday()).toEqual(["Football: Family", "Holiday: Mia", "Piano lesson: Mia"]);
    expect(await tuesday([mia]), "whole-Family Items show always").toEqual(["Football: Family", "Holiday: Mia", "Piano lesson: Mia"]);
    expect(await tuesday([leo])).toEqual(["Football: Family"]);
  });

  it("attributes Items anew when a Source is assigned to others or to no one", async () => {
    await arrive({ calendar: [entry("Piano lesson")] });
    await assign(calendar, [leo, mia]);
    expect(await tuesday(), "in the Family's order").toEqual(["Piano lesson: Mia, Leo"]);

    await assign(calendar, [leo]);
    expect(await tuesday()).toEqual(["Piano lesson: Leo"]);

    await assign(calendar, []);
    expect(await tuesday()).toEqual(["Piano lesson: Family"]);
  });

  it("carries in a View's feed the Items concerning its preselected Family Members, and whole-Family ones", async () => {
    await arrive({ calendar: [entry("Piano lesson")], club: [entry("Football")] });
    await assign(calendar, [mia]);
    const titles = async (preselected: FamilyMemberId[]) => {
      const created = await instance.app.views.create({ preselected, horizonDays: 7 });
      if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
      const feed = await instance.app.views.feed(created.id, { access: openViewAccess });
      return feed?.events.map((event) => event.title).sort();
    };

    expect(await titles([mia])).toEqual(["Football", "Piano lesson"]);
    expect(await titles([leo])).toEqual(["Football"]);
    await assign(club, [leo]);
    expect(await titles([mia])).toEqual(["Piano lesson"]);
  });

  it("lists a Source with whom it concerns, and forgets removed Family Members", async () => {
    await arrive({ calendar: [entry("Piano lesson")] });
    await assign(calendar, [leo, mia]);
    const concerns = async () => (await instance.app.sources.list()).find((source) => source.id === calendar)?.concerns;

    expect(await concerns(), "in the Family's order").toEqual([mia, leo]);

    await instance.app.familyMembers.remove(mia);
    expect(await concerns()).toEqual([leo]);
    await instance.app.familyMembers.remove(leo);
    expect(await concerns()).toEqual([]);
    expect(await tuesday(), "a Source left without anyone concerns the whole Family").toEqual(["Piano lesson: Family"]);
  });

  it("refuses to assign an unknown Source or Family Member", async () => {
    const stranger = "00000000-0000-4000-8000-000000000000" as FamilyMemberId;

    expect(await instance.app.sources.assign(calendar, [mia, stranger])).toEqual({ ok: false, problem: "unknown-member" });
    expect(await instance.app.sources.assign("nope" as SourceId, [mia])).toEqual({ ok: false, problem: "unknown-source" });
    expect((await instance.app.sources.list()).find((source) => source.id === calendar)?.concerns).toEqual([]);
  });
});

describe("Attribution by Part of a Source", () => {
  let instance: TestInstance;
  let mailbox: SourceId;
  let mia: FamilyMemberId;
  let leo: FamilyMemberId;
  let view: ViewId;
  beforeEach(async () => {
    instance = await bootForTest();
    await writeTestPluginPackage(instance.workspacePackages, {
      sourceTypeId: "mailbox",
      configuration: `{
        version: 1,
        fields: [{ key: "folders", label: "Folders", secret: false, required: false, parts: true }],
      }`,
    });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    const member = async (name: string) => {
      const result = await instance.app.familyMembers.add({ name });
      if (!result.ok) throw new Error(`adding failed: ${result.problem}`);
      return result.id;
    };
    mia = await member("Mia");
    leo = await member("Leo");
    const added = await instance.app.sources.add({
      sourceTypeId: "mailbox",
      plain: { folders: ["School", "Club", "Inbox"] },
      secrets: {},
      partConcerns: { School: [mia], Club: [leo, mia] },
    });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    mailbox = added.id;
    const created = await instance.app.views.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    view = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  const inFolder = (part: string, key: string): Origin => ({ ...entry(key), part });

  const tuesday = async () => {
    const page = await openTimeline(instance.app, view, { access: openViewAccess, show: "all" });
    const names = new Map(page?.members.map((member) => [member.id, member.name]));
    const day = page?.days.find((candidate) => candidate.date === "2026-09-15");
    return (day?.items ?? []).map(
      (row) => `${row.title}: ${row.concerns === "whole-family" ? "Family" : row.concerns.map((id) => names.get(id)).join(", ")}`,
    );
  };

  const arrive = async (origins: Origin[]) => {
    testPluginControls.emit("mailbox", origins);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
  };

  it("lets an Item concern whom its folder is assigned to, and the whole Family for a folder assigned to no one", async () => {
    await arrive([inFolder("School", "Elternabend"), inFolder("Club", "Training"), inFolder("Inbox", "Newsletter")]);

    expect(await tuesday()).toEqual(["Elternabend: Mia", "Newsletter: Family", "Training: Mia, Leo"]);
  });

  it("attributes anew when a folder is assigned to others", async () => {
    await arrive([inFolder("School", "Elternabend")]);

    const edited = await instance.app.sources.edit(mailbox, {
      plain: { folders: ["School", "Club", "Inbox"] },
      secrets: {},
      partConcerns: { School: [leo] },
    });

    expect(edited).toEqual({ ok: true });
    expect(await tuesday()).toEqual(["Elternabend: Leo"]);
    expect((await instance.app.sources.list()).find((source) => source.id === mailbox)?.partConcerns).toEqual({ School: [leo] });
  });

  it("forgets the assignment of a folder that was removed", async () => {
    await instance.app.sources.edit(mailbox, { plain: { folders: ["Club"] }, secrets: {}, partConcerns: { School: [mia], Club: [leo] } });

    expect((await instance.app.sources.list()).find((source) => source.id === mailbox)?.partConcerns).toEqual({ Club: [leo] });
  });

  it("ignores a folder assigned to an unknown Family Member", async () => {
    const stranger = "00000000-0000-4000-8000-000000000000" as FamilyMemberId;

    const edited = await instance.app.sources.edit(mailbox, {
      plain: { folders: ["School"] },
      secrets: {},
      partConcerns: { School: [stranger] },
    });

    expect(edited.ok).toBe(true);
    expect((await instance.app.sources.list()).find((source) => source.id === mailbox)?.partConcerns).toEqual({});
  });
});
