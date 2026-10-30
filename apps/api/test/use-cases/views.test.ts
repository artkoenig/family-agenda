import type { FamilyMemberId, ViewId } from "@family-agenda/domain";
import { openViewAccess, type ViewAccessPolicy } from "@family-agenda/application";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";

describe("configuring Views", () => {
  let instance: TestInstance;
  let mia: FamilyMemberId;
  let leo: FamilyMemberId;
  beforeEach(async () => {
    instance = await bootForTest();
    mia = await addMember("Mia");
    leo = await addMember("Leo");
  });
  afterEach(async () => {
    await instance.close();
  });

  const addMember = async (name: string) => {
    const added = await instance.app.familyMembers.add({ name });
    if (!added.ok) throw new Error("adding failed");
    return added.id;
  };

  const createView = async (input: { kind?: string; preselected: FamilyMemberId[]; horizonDays: number }) => {
    const created = await instance.app.views.create(input);
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    return created.id;
  };

  const open = (id: ViewId, access: ViewAccessPolicy = openViewAccess) =>
    instance.app.views.open(id, { access });

  it("creates Views with preselected Family Members and a horizon", async () => {
    const forMia = await createView({ preselected: [mia], horizonDays: 7 });
    const kitchen = await createView({ preselected: [leo, mia], horizonDays: 3 });

    expect(await instance.app.views.list()).toEqual([
      { id: forMia, kind: "timeline", preselected: [mia], horizonDays: 7 },
      { id: kitchen, kind: "timeline", preselected: [mia, leo], horizonDays: 3 },
    ]);
  });

  it("makes a View a Task List, keeps its kind when an edit names none, and refuses a kind it does not know", async () => {
    const list = await createView({ kind: "tasks", preselected: [mia], horizonDays: 7 });

    expect(await instance.app.views.edit(list, { preselected: [mia, leo], horizonDays: 7 })).toEqual({ ok: true });
    expect(await instance.app.views.list()).toEqual([{ id: list, kind: "tasks", preselected: [mia, leo], horizonDays: 7 }]);
    expect((await open(list))?.kind).toBe("tasks");
    expect(await instance.app.views.create({ kind: "agenda", preselected: [], horizonDays: 7 })).toEqual({ ok: false, problem: "unknown-kind" });
    expect(await instance.app.views.edit(list, { kind: "timeline", preselected: [], horizonDays: 7 })).toEqual({ ok: true });
    expect((await open(list))?.kind).toBe("timeline");
  });

  it("refuses a horizon outside 1 to 31 days, and Family Members it does not know", async () => {
    for (const horizonDays of [0, 32, 2.5]) {
      expect(await instance.app.views.create({ preselected: [], horizonDays })).toEqual({
        ok: false,
        problem: "invalid-horizon",
      });
    }
    expect(
      await instance.app.views.create({
        preselected: ["3f0b2a52-0000-4000-8000-000000000000" as FamilyMemberId],
        horizonDays: 7,
      }),
    ).toEqual({ ok: false, problem: "unknown-member" });
    expect(await instance.app.views.list()).toEqual([]);
  });

  it("edits and removes Views", async () => {
    const view = await createView({ preselected: [mia], horizonDays: 7 });

    expect(await instance.app.views.edit(view, { preselected: [leo], horizonDays: 14 })).toEqual({
      ok: true,
    });
    expect(await instance.app.views.edit(view, { preselected: [], horizonDays: 0 })).toEqual({
      ok: false,
      problem: "invalid-horizon",
    });
    expect(await instance.app.views.list()).toEqual([
      { id: view, kind: "timeline", preselected: [leo], horizonDays: 14 },
    ]);

    await instance.app.views.remove(view);
    expect(await instance.app.views.list()).toEqual([]);
    expect(await open(view)).toBeNull();
    expect(await instance.app.views.edit(view, { preselected: [], horizonDays: 7 })).toEqual({
      ok: false,
      problem: "unknown-view",
    });
  });

  it("drops a removed Family Member from the Views that preselect them", async () => {
    const view = await createView({ preselected: [mia, leo], horizonDays: 7 });

    await instance.app.familyMembers.remove(mia);

    expect(await instance.app.views.list()).toEqual([
      { id: view, kind: "timeline", preselected: [leo], horizonDays: 7 },
    ]);
  });

  it("opens a View as one day per day of its horizon, starting today in the Family's time zone", async () => {
    // 22:30 UTC is already the next day in Berlin.
    instance.clock.advance(15.5 * 60 * 60 * 1000);
    const view = await createView({ preselected: [mia], horizonDays: 3 });

    const page = await open(view);

    expect(page).toMatchObject({
      id: view,
      now: { date: "2026-09-15", time: "00:30" },
      days: [
        { date: "2026-09-15", items: [] },
        { date: "2026-09-16", items: [] },
        { date: "2026-09-17", items: [] },
      ],
    });
    expect(page?.members.map((member) => member.name)).toEqual(["Mia", "Leo"]);
  });

  it("offers in the quick filter only the preselected Family Members, and combines any of them", async () => {
    const kitchen = await createView({ preselected: [leo, mia], horizonDays: 1 });
    const everyone = await createView({ preselected: [], horizonDays: 1 });

    const kitchenPage = await open(kitchen);
    expect(kitchenPage?.choices.map((member) => member.name)).toEqual(["Mia", "Leo"]);
    expect(kitchenPage?.showing).toEqual([mia, leo]);
    const everyonePage = await open(everyone);
    expect(everyonePage?.choices.map((member) => member.name)).toEqual(["Mia", "Leo"]);
    expect(everyonePage?.showing).toBe("all");

    const showing = async (view: ViewId, show: FamilyMemberId[] | "all") =>
      (await instance.app.views.open(view, { access: openViewAccess, show }))?.showing;
    expect(await showing(kitchen, [leo])).toEqual([leo]);
    expect(await showing(kitchen, "all")).toEqual([mia, leo]);
    expect(await showing(kitchen, [])).toEqual([mia, leo]);
    expect(await showing(everyone, [leo, mia])).toEqual([mia, leo]);
    expect(await showing(everyone, [])).toBe("all");
    const stranger = "no-such-member" as FamilyMemberId;
    expect(await showing(everyone, [stranger, leo])).toEqual([leo]);
  });

  it("shows only the preselected Family Member, whom the quick filter cannot leave", async () => {
    const forMia = await createView({ preselected: [mia], horizonDays: 1 });

    const page = await instance.app.views.open(forMia, { access: openViewAccess, show: [leo] });

    expect(page?.choices.map((member) => member.name)).toEqual(["Mia"]);
    expect(page?.showing).toEqual([mia]);
  });

  it("opens no View that its access policy refuses", async () => {
    const view = await createView({ preselected: [], horizonDays: 7 });
    const closed: ViewAccessPolicy = { mayOpen: () => Promise.resolve(false) };

    expect(await open(view, closed)).toBeNull();
  });
});
