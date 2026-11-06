import type { Origin, StatedTask } from "@family-agenda/source-sdk";
import { openAgendaAccess } from "@family-agenda/application";
import type { AgendaId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

/** A Task as a Source states it, whole; a packing list for a swimming lesson unless told otherwise. */
const swimming = (stated: Partial<StatedTask> = {}): Origin => ({
  externalId: "swimming",
  attributes: ["main"],
  content: { kind: "stated", stated: { kind: "task", title: "Bring a swimsuit", deadline: "2026-09-18", bring: ["Swimsuit", "Towel"], ...stated } },
});

describe("Tasks a Source states", () => {
  let instance: TestInstance;
  let agenda: AgendaId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootForTest();
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "homework" });
    await instance.restart();
    await instance.app.sourceTypes.enable("homework");
    const added = await instance.app.sources.add({ sourceTypeId: "homework", plain: { url: "https://school.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    agenda = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The Source states these Tasks on its next run, and the worker runs it. */
  const arrive = async (...origins: Origin[]) => {
    testPluginControls.emit("homework", origins);
    instance.clock.advance(15 * minutes);
    return instance.app.polling.pollDue();
  };

  /** Every Task the Agenda shows, pinned or on its day. */
  const shown = async () => {
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    return [...(page?.pinned ?? []), ...(page?.days ?? []).flatMap((day) => day.tasks)];
  };

  it("shows a stated Task with its Deadline and the things to bring, as one a message stated", async () => {
    await arrive(swimming());

    expect(await shown()).toMatchObject([{ title: "Bring a swimsuit", deadline: "2026-09-18", bring: ["Swimsuit", "Towel"], status: "upcoming", cancelled: false }]);
  });

  it("changes the Task when the Source states it differently, and leaves it ticked done if it was", async () => {
    await arrive(swimming());
    const [before] = await shown();
    await instance.app.tasks.tickFromAgenda(agenda, before!.itemId, { done: true, access: openAgendaAccess });

    await arrive(swimming({ title: "Bring a swimsuit and goggles", deadline: "2026-09-19", bring: ["Swimsuit", "Goggles"] }));

    expect(await shown()).toMatchObject([
      { itemId: before!.itemId, title: "Bring a swimsuit and goggles", deadline: "2026-09-19", bring: ["Swimsuit", "Goggles"], status: "done" },
    ]);
  });

  it("keeps a Task ticked done when the Source states it again unchanged", async () => {
    await arrive(swimming());
    const [before] = await shown();
    await instance.app.tasks.tickFromAgenda(agenda, before!.itemId, { done: true, access: openAgendaAccess });

    await arrive(swimming());

    expect(await shown()).toMatchObject([{ itemId: before!.itemId, status: "done" }]);
  });

  it("removes the Task when the Source withdraws it, also one that was ticked done", async () => {
    await arrive(swimming());
    const [before] = await shown();
    await instance.app.tasks.tickFromAgenda(agenda, before!.itemId, { done: true, access: openAgendaAccess });

    testPluginControls.withdraw("homework", ["swimming"]);
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();

    expect(await shown()).toEqual([]);
  });

  it("writes no Task it states invalidly, and warns beside the Source Status", async () => {
    const [source] = await instance.app.sources.list();

    const report = await arrive(swimming({ title: "" }));

    expect(report.invalid).toEqual([{ sourceId: source!.id, externalId: "swimming", problems: ["title is not a non-empty text"] }]);
    expect(await shown()).toEqual([]);
    expect(await instance.app.sources.list()).toMatchObject([{ health: { invalidRecords: ["swimming"] } }]);
  });
});
