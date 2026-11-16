import type { FamilyMemberId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTestBelow, type HttpPrefixedTestInstance } from "../support/http";
import { photos } from "../support/photos";
import { seedTasks } from "../support/seed-task";

const prefix = "/agenda";

/** Every address a page emits from the root of the Instance that does not lie below the prefix. */
const outside = (body: string) => body.match(/(?:href|src|action|hx-get|hx-post)="\/(?!agenda\/)[^"]*"/g) ?? [];

describe("an Agenda below a path prefix", () => {
  let instance: HttpPrefixedTestInstance;
  let agenda: string;
  let tasks: string;
  let mia: FamilyMemberId;
  beforeEach(async () => {
    instance = await bootHttpForTestBelow(prefix, {}, { sourcePlugins: [{ sourceTypeId: "school" }] });
    await instance.app.recoveryKit.confirm();
    await instance.app.sourceTypes.enable("school");
    await instance.app.sources.add({ sourceTypeId: "school", plain: { url: "https://school.example.org" }, secrets: {} });
    const member = await instance.app.familyMembers.add({ name: "Mia", photo: photos.png });
    if (!member.ok) throw new Error("adding Mia failed");
    mia = member.id;
    await instance.app.familyMembers.add({ name: "Ben" });
    // An Agenda for everyone holds the Task, which is for no one in particular, and offers the quick filter.
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    agenda = created.id;
    const list = await instance.app.agendas.create({ memberIds: [mia], horizonDays: 3, layout: "task_list" });
    if (!list.ok) throw new Error("creating the Task List failed");
    tasks = list.id;
    await seedTasks((sql) => instance.query(sql), { key: "kit", title: "Bring sports kit", deadline: "2026-09-14", sentAt: "2026-09-10T10:00:00Z" });
  });
  afterEach(async () => {
    await instance.close();
  });

  it("keeps every link and background request of the Agenda below the prefix", async () => {
    for (const id of [agenda, tasks]) {
      const page = await (await instance.get(`${prefix}/agendas/${id}`)).text();
      expect(outside(page)).toEqual([]);
      expect(page).toContain(`<link rel="manifest" href="${prefix}/agendas/${id}/manifest.webmanifest"`);
      expect(page).toContain(`hx-get="${prefix}/agendas/${id}/activity"`);
      expect(page).toContain(`href="${prefix}/static/icons/apple-touch-icon.png?v=`);
    }
    const page = await (await instance.get(`${prefix}/agendas/${agenda}`)).text();
    expect(page).toContain(`hx-get="${prefix}/agendas/${agenda}/days?`);
    expect(page).toContain(`href="${prefix}/agendas/${agenda}?show=all"`);
    expect(page).toContain(`action="${prefix}/agendas/${agenda}/tasks/`);
    const days = /hx-get="([^"]*\/days\?[^"]*)"/.exec(page)?.[1]?.replaceAll("&amp;", "&") ?? "";
    const more = await instance.get(days);
    expect(more.status).toBe(200);
    expect(outside(await more.text())).toEqual([]);
    const activity = await instance.get(`${prefix}/agendas/${agenda}/activity`);
    expect(outside(await activity.text())).toEqual([]);
  });

  it("ticks a Task and returns to the Agenda below the prefix", async () => {
    const page = await (await instance.get(`${prefix}/agendas/${agenda}`)).text();
    const tick = /action="([^"]*\/tasks\/[^"]*\/done)"/.exec(page)?.[1] ?? "";
    const ticked = await instance.post(tick, {});
    expect(ticked.status).toBe(303);
    expect(ticked.headers.get("location")).toBe(`${prefix}/agendas/${agenda}`);
    const swapped = await instance.post(tick.replace(/done$/, "undone"), {}, { headers: { "hx-request": "true" } });
    expect(outside(await swapped.text())).toEqual([]);
  });

  it("installs the Agenda with its addresses below the prefix", async () => {
    const manifest = (await (await instance.get(`${prefix}/agendas/${agenda}/manifest.webmanifest`)).json()) as {
      id: string;
      start_url: string;
      scope: string;
      icons: { src: string }[];
    };
    expect(manifest.id).toBe(`${prefix}/agendas/${agenda}`);
    expect(manifest.start_url).toBe(`${prefix}/agendas/${agenda}`);
    expect(manifest.scope).toBe(`${prefix}/agendas/${agenda}`);
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith(`${prefix}/static/icons/`)).toBe(true);
      expect((await instance.get(icon.src)).status).toBe(200);
    }
  });

  it("serves the feed below the prefix, the Agenda's address in it included", async () => {
    const feed = await instance.get(`${prefix}/agendas/${agenda}/feed.ics`);
    expect(feed.status).toBe(200);
    expect(await feed.text()).toContain(`URL:http://localhost${prefix}/agendas/${agenda}`);
  });

  it("loads a Family Member's photo below the prefix", async () => {
    const page = await (await instance.get(`${prefix}/agendas/${agenda}`)).text();
    expect(page).toContain(`<img src="${prefix}/family-members/${mia}/photo"`);
    expect((await instance.get(`${prefix}/family-members/${mia}/photo`)).status).toBe(200);
  });

  it("loads the stylesheets, fonts, icons and scripts below the prefix", async () => {
    const page = await (await instance.get(`${prefix}/agendas/${agenda}`)).text();
    const statics = [...page.matchAll(/(?:href|src)="([^"]*\/static\/[^"]*)"/g)].map((match) => match[1] ?? "");
    expect(statics.length).toBeGreaterThan(4);
    for (const path of statics) expect((await instance.get(path)).status, path).toBe(200);

    // A stylesheet's own addresses resolve against where it was loaded from, below the prefix.
    for (const sheet of ["tokens.css", "design.css", "avatars.css"]) {
      const base = `http://localhost${prefix}/static/${sheet}`;
      const css = await (await instance.get(`${prefix}/static/${sheet}`)).text();
      // No address from the root of the Instance is left, however it is quoted.
      expect(css.match(/(?:url\(\s*["']?|@import\s+(?:url\(\s*)?["']?)\/static\//g) ?? [], sheet).toEqual([]);
      if (sheet === "design.css") continue;
      const urls = [...css.matchAll(/url\("?([^")]+)"?\)/g)].map((match) => new URL(match[1] ?? "", base).pathname);
      expect(urls.length).toBeGreaterThan(0);
      for (const path of urls) {
        expect(path.startsWith(`${prefix}/static/`), path).toBe(true);
        expect((await instance.get(path)).status, path).toBe(200);
      }
    }
  });

  it("loads the stylesheets, fonts and scripts of the Admin area below the prefix", async () => {
    const page = await (await instance.get(`${prefix}/admin/sign-in`)).text();
    expect(outside(page)).toEqual([]);
    const statics = [...page.matchAll(/(?:href|src)="([^"]*\/static\/[^"]*)"/g)].map((match) => match[1] ?? "");
    expect(statics).toEqual(expect.arrayContaining([`${prefix}/static/tokens.css`, `${prefix}/static/htmx.min.js`]));
    for (const path of statics) expect((await instance.get(path)).status, path).toBe(200);
  });
});
