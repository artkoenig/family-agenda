import type { Origin } from "@family-agenda/source-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls } from "../support/test-source-plugin";

const password = "correct horse battery";

/** A created Task, as a structured Source emits it. */
const task = (key: string, fields: Record<string, unknown>): Origin => ({
  externalId: key,
  occurredAt: new Date("2026-09-10T10:00:00Z"),
  attributes: {},
  content: { kind: "revisions", revisions: [{ itemKind: "task", itemKey: key, action: "create", fields: fields as never }] },
});

describe("Tasks over HTTP", () => {
  let instance: HttpTestInstance;
  let path: string;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "school" }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    await instance.app.sourceTypes.enable("school");
    await instance.app.sources.add({ sourceTypeId: "school", plain: { url: "https://school.example.org" }, secrets: {} });
    const created = await instance.app.views.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    path = `/views/${created.id}`;
    testPluginControls.emit("school", [
      task("kit", { title: "Bring sports kit", deadline: "2026-09-14", bring: ["Trainers", "Towel"] }),
      task("form", { title: "Sign the trip form" }),
      task("photos", { title: "Pay for the photos", deadline: "2026-09-16" }),
    ]);
    await instance.app.polling.pollDue();
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The pinned area of a View page, from its `<section>` to `</section>`. */
  const pinnedOf = (page: string) => /<section class="fam-tasks"(?:(?!<\/section>).)*<\/section>/s.exec(page)?.[0] ?? "";

  /** The row of the Task with the given title. */
  const rowOf = (page: string, title: string) =>
    new RegExp(`<li class="fam-task[^"]*"(?:(?!</li>).)*${title}(?:(?!</li>).)*</li>`, "s").exec(page)?.[0] ?? "";

  /** Where the tick of a Task row posts to. */
  const tickOf = (row: string) => /<form[^>]*action="([^"]+)"/.exec(row)?.[1] ?? "";

  it("pins Due Tasks at the top of a View, with their things to bring, and shows later ones on their day", async () => {
    const page = await (await instance.get(path)).text();

    const pinned = pinnedOf(page);
    expect(pinned).toContain("To do");
    expect(rowOf(pinned, "Bring sports kit")).toContain("Trainers, Towel");
    expect(rowOf(pinned, "Bring sports kit")).toContain("Due");
    expect(rowOf(pinned, "Sign the trip form")).toContain("Due");
    expect(pinned).not.toContain("Pay for the photos");
    const later = page.slice(page.indexOf('data-date="2026-09-16"'));
    expect(rowOf(later, "Pay for the photos")).toContain("Mark “Pay for the photos” done");
  });

  it("ticks a Task done through a View without a session, and takes the tick back", async () => {
    const page = await (await instance.get(path)).text();
    const tick = tickOf(rowOf(pinnedOf(page), "Bring sports kit"));
    expect(tick).toMatch(new RegExp(`^${path}/tasks/[0-9a-f-]+/done$`));

    const response = await instance.post(tick, { from: "2026-09-14", until: "2026-09-16", show: "all" }, { headers: { "hx-request": "true" } });

    expect(response.status).toBe(200);
    const after = await response.text();
    expect(after).toMatch(/^<main id="view"/);
    expect(pinnedOf(after)).not.toContain("Bring sports kit");
    const done = rowOf(after, "Bring sports kit");
    expect(done).toContain("fam-task--done");
    expect(done).toContain("Mark “Bring sports kit” not done");
    const ticks = await instance.app.tasks.ticks(tick.split("/")[4] as never);
    expect(ticks).toMatchObject([{ done: true, by: { kind: "view", viewId: path.split("/")[2] } }]);

    const undone = await instance.post(tickOf(done), {});
    expect(undone.status).toBe(303);
    expect(undone.headers.get("location")).toBe(path);
    expect(rowOf(pinnedOf(await (await instance.get(path)).text()), "Bring sports kit")).toContain("Due");
  });

  it("refuses a tick from another site, and one of an unknown Task", async () => {
    const page = await (await instance.get(path)).text();
    const tick = tickOf(rowOf(pinnedOf(page), "Sign the trip form"));

    const forged = await instance.post(tick, {}, { headers: { origin: "https://evil.example.org" } });
    expect(forged.status).toBe(403);
    const unknown = await instance.post(`${path}/tasks/3f0b2a52-0000-4000-8000-000000000000/done`, {});
    expect(unknown.status).toBe(404);
    expect(pinnedOf(await (await instance.get(path)).text())).toContain("Sign the trip form");
  });

  it("lets an Admin tick Tasks in the Admin area, and shows who ticked them when", async () => {
    const page = await (await instance.get(path)).text();
    await instance.post(tickOf(rowOf(pinnedOf(page), "Bring sports kit")), {});
    expect((await instance.get("/admin/tasks")).status).toBe(302);
    const cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));

    const tasks = await (await instance.get("/admin/tasks", { cookie })).text();
    expect(rowOf(tasks, "Bring sports kit")).toContain("Done in the View for everyone at Mon 14 Sept, 09:00");
    const form = tickOf(rowOf(tasks, "Sign the trip form"));
    expect(form).toMatch(/^\/admin\/tasks\/[0-9a-f-]+\/done$/);

    const ticked = await instance.post(form, {}, { cookie });
    expect(ticked.status).toBe(303);
    expect(ticked.headers.get("location")).toBe("/admin/tasks");
    const after = await (await instance.get("/admin/tasks", { cookie })).text();
    expect(rowOf(after, "Sign the trip form")).toContain("Done by anna@example.org at Mon 14 Sept, 09:00");
    expect(pinnedOf(await (await instance.get(path)).text())).not.toContain("Sign the trip form");
  });
});
