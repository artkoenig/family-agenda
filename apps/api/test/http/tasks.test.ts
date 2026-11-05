import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { seedTasks } from "../support/seed-task";

const password = "correct horse battery";

/** A Task a message stated before the week began. */
const task = (key: string, fields: { title: string; deadline?: string; bring?: string[] }) => ({ key, sentAt: "2026-09-10T10:00:00Z", ...fields });

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
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    path = `/agendas/${created.id}`;
    await seedTasks(
      (sql) => instance.query(sql),
      task("kit", { title: "Bring sports kit", deadline: "2026-09-14", bring: ["Trainers", "Towel"] }),
      task("form", { title: "Sign the trip form" }),
      task("photos", { title: "Pay for the photos", deadline: "2026-09-16" }),
    );
  });
  afterEach(async () => {
    await instance.close();
  });

  /** The pinned area of an Agenda page, from its `<section>` to `</section>`. */
  const pinnedOf = (page: string) => /<section class="fam-tasks"(?:(?!<\/section>).)*<\/section>/s.exec(page)?.[0] ?? "";

  /** The row of the Task with the given title. */
  const rowOf = (page: string, title: string) =>
    new RegExp(`<li class="fam-item fam-task[^"]*"(?:(?!</li>).)*${title}(?:(?!</li>).)*</li>`, "s").exec(page)?.[0] ?? "";

  /** Where the tick of a Task row posts to. */
  const tickOf = (row: string) => /<form[^>]*action="([^"]+)"/.exec(row)?.[1] ?? "";

  it("pins Due Tasks at the top of an Agenda, with their things to bring, and shows later ones on their day", async () => {
    const page = await (await instance.get(path)).text();

    const pinned = pinnedOf(page);
    expect(pinned).toContain("To do");
    expect(rowOf(pinned, "Bring sports kit")).toContain("Trainers, Towel");
    expect(rowOf(pinned, "Bring sports kit")).toContain("Due");
    expect(rowOf(pinned, "Sign the trip form")).toContain("Due");
    expect(pinned).not.toContain("Pay for the photos");
    const later = page.slice(page.indexOf('data-date="2026-09-16"'));
    const onDay = rowOf(later, "Pay for the photos");
    expect(onDay).toContain("Mark “Pay for the photos” done");
    // On its day, the tick takes the place of the time, and the day says the Deadline.
    expect(onDay).toMatch(/<span class="fam-item__lead"><form/);
    expect(onDay).not.toContain("By ");
    expect(rowOf(pinned, "Bring sports kit")).not.toContain("fam-item__lead");
  });

  it("ticks a Task done through an Agenda without a session, and takes the tick back", async () => {
    const page = await (await instance.get(path)).text();
    const tick = tickOf(rowOf(pinnedOf(page), "Bring sports kit"));
    expect(tick).toMatch(new RegExp(`^${path}/tasks/[0-9a-f-]+/done$`));

    const response = await instance.post(tick, { from: "2026-09-14", until: "2026-09-16", show: "all" }, { headers: { "hx-request": "true" } });

    expect(response.status).toBe(200);
    const after = await response.text();
    expect(after).toMatch(/^<main id="agenda"/);
    expect(pinnedOf(after)).not.toContain("Bring sports kit");
    const done = rowOf(after, "Bring sports kit");
    expect(done).toContain("fam-task--done");
    expect(done).toContain("Mark “Bring sports kit” not done");
    expect(await instance.query(`SELECT status FROM task WHERE item_id = '${tick.split("/")[4]}'`)).toEqual([{ status: "done" }]);

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

  it("ticks with the design system's checkbox, which posts once it changes", async () => {
    const row = rowOf(pinnedOf(await (await instance.get(path)).text()), "Bring sports kit");

    expect(row).toMatch(/<form[^>]*hx-trigger="change"/);
    expect(row).toMatch(/<label class="fam-task__tick"><input type="checkbox" aria-label="Mark “Bring sports kit” done"\/?><\/label>/);
    expect(row).not.toContain("aria-pressed");
  });

  it("lists the Tasks in a Task List Agenda, ticks them there, and says nothing of who ticked them", async () => {
    const created = await instance.app.agendas.create({ layout: "task_list", memberIds: [], horizonDays: 7 });
    if (!created.ok) throw new Error("creating failed");
    const list = `/agendas/${created.id}`;
    await instance.post(tickOf(rowOf(pinnedOf(await (await instance.get(path)).text()), "Sign the trip form")), {});

    const page = await (await instance.get(list)).text();
    expect(page).toContain("<title>Task List");
    expect(page).not.toContain('class="fam-days"');
    const section = (id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}"(?:(?!</section>).)*</section>`, "s").exec(page)?.[0] ?? "";
    expect(section("to-do")).toContain("Bring sports kit");
    expect(section("coming-up")).toContain("Pay for the photos");
    expect(section("done")).toContain("Sign the trip form");
    expect(rowOf(section("done"), "Sign the trip form")).toMatch(/<input type="checkbox" checked=""/);
    expect(page).not.toContain("in the Agenda for");

    const tick = tickOf(rowOf(section("to-do"), "Bring sports kit"));
    const response = await instance.post(tick, { show: "all" }, { headers: { "hx-request": "true" } });
    expect(response.status).toBe(200);
    const after = await response.text();
    expect(after).toMatch(/^<main id="agenda"/);
    expect(after).toContain('aria-labelledby="done"');
    expect(rowOf(after, "Bring sports kit")).toContain("fam-task--done");
    expect((await instance.get(`${list}/days?from=2026-09-14&until=2026-09-16&then=later`)).status).toBe(404);
  });

  it("leaves the Tasks to the Agendas, with no section of their own in the Admin area", async () => {
    const cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));

    expect((await instance.get("/admin/tasks", { cookie })).status).toBe(404);
    expect(await (await instance.get("/admin/agendas", { cookie })).text()).not.toContain('href="/admin/tasks"');
  });
});
