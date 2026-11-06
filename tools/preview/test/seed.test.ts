import { cp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openAgendaAccess } from "@family-agenda/application";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../../../apps/api/test/support/boot";
import { openTimeline } from "../../../apps/api/test/support/timeline";
import { seedDemoFamily } from "../src/seed";

const demoSource = fileURLToPath(new URL("../../demo-source", import.meta.url));

describe("seeding a demo Family into an Instance", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
    // As a preview does: the demo Source plugin sits in the plugins directory, outside the image's own packages.
    const installed = join(instance.pluginDirectory, "demo-source");
    await cp(demoSource, installed, { recursive: true, filter: (path) => !path.includes("node_modules") });
    // In the image Node's loader hands the plugin the SDK (ADR-0010); Vitest's does not, so the plugin brings its own.
    await symlink(join(demoSource, "node_modules"), join(installed, "node_modules"));
    await instance.restart();
  });
  afterEach(async () => {
    await instance.close();
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
});
