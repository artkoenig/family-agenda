import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openAgendaAccess } from "@family-agenda/application";
import type { SourceTypeId } from "@family-agenda/domain";
import { servePlugin } from "@family-agenda/plugin-kit/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../../../apps/api/test/support/boot";
import { openTimeline } from "../../../apps/api/test/support/timeline";
import { demoPlugin } from "../../demo-source/src/plugin";
import { seedDemoFamily } from "../src/seed";

describe("seeding a demo Family into an Instance", () => {
  let instance: TestInstance;
  let server: Server;
  beforeEach(async () => {
    // As a preview does: the demo Source runs as a plugin container of its own.
    server = await servePlugin(demoPlugin, { host: "127.0.0.1" });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    instance = await bootForTest({ pluginContainers: [{ sourceTypeId: "demo" as SourceTypeId, url }] });
  });
  afterEach(async () => {
    await instance.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it("gives the Family Agendas that show Events and Lessons on the days ahead", async () => {
    const seeded = await seedDemoFamily(instance.app);
    if (!seeded.ok) throw new Error(`seeding failed: ${seeded.problem}`);

    const familyAgenda = seeded.agendas.find((agenda) => agenda.audience === "the Family");
    if (!familyAgenda) throw new Error("no Family Agenda");
    const page = await openTimeline(instance.app, familyAgenda.id, { access: openAgendaAccess });

    const days = page?.days ?? [];
    const events = days.flatMap((day) => day.items.map((event) => event.title));
    const lessons = days.flatMap((day) => day.schoolDays.flatMap((row) => row.lessons.map((lesson) => lesson.subject)));
    expect(events).toContain("Football training");
    expect(lessons).toContain("Mathematics");
  });

  it("keeps a child's Agenda to what concerns the child", async () => {
    const seeded = await seedDemoFamily(instance.app);
    if (!seeded.ok) throw new Error(`seeding failed: ${seeded.problem}`);
    const emma = seeded.agendas.find((agenda) => agenda.audience === "Emma");
    if (!emma) throw new Error("no Agenda for Emma");

    const days = (await openTimeline(instance.app, emma.id, { access: openAgendaAccess }))?.days ?? [];

    expect(days.flatMap((day) => day.schoolDays.flatMap((row) => row.lessons.map((lesson) => lesson.subject)))).toContain("German");
    expect(days.flatMap((day) => day.items.map((event) => event.title))).not.toContain("Football training");
  });

  it("refuses to seed an Instance that already has an Admin", async () => {
    await instance.app.admins.createFirstAdmin({ email: "real@example.org", password: "a real password" });

    expect(await seedDemoFamily(instance.app)).toEqual({ ok: false, problem: "admin-exists" });
  });

  it("gives the Family a Task List with the Tasks that are due or coming", async () => {
    const seeded = await seedDemoFamily(instance.app);
    if (!seeded.ok) throw new Error(`seeding failed: ${seeded.problem}`);
    const taskList = seeded.agendas.find((agenda) => agenda.audience === "the Family's Tasks");
    if (!taskList) throw new Error("no Task List");

    const page = await instance.app.agendas.open(taskList.id, { access: openAgendaAccess });

    expect(page?.layout).toBe("task_list");
    const titles = page?.layout === "task_list" ? [...page.due, ...page.upcoming].map((task) => task.title) : [];
    expect(titles).toEqual(expect.arrayContaining(["Bring the swimming kit", "Sign the class trip form"]));
  });
});
