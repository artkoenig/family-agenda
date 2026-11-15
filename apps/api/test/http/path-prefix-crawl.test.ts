import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTestBelow, type HttpPrefixedTestInstance } from "../support/http";
import { photos } from "../support/photos";
import { seedTasks } from "../support/seed-task";

const password = "correct horse battery";
const prefix = "/agenda";
const origin = "http://localhost";

/** Every address a page names: in a link, a source, a form, a background request or a redirect of htmx. */
const addressesIn = (body: string) =>
  [...body.matchAll(/\s(href|src|action|formaction|poster|hx-get|hx-post|hx-put|hx-patch|hx-delete|hx-push-url)="([^"]*)"/g)].map(
    ([, attribute = "", value = ""]) => ({ attribute, value: value.replaceAll("&amp;", "&") }),
  );

/** The path an address leads to on this Instance, or undefined for one elsewhere (or a fragment, `mailto:`, `data:`, …). */
const pathOf = (address: string, base: string): string | undefined => {
  if (address === "" || address.startsWith("#") || /^(mailto|tel|data|webcal|javascript):/i.test(address)) return undefined;
  const url = new URL(address, origin + base);
  return url.origin === origin ? url.pathname + url.search : undefined;
};

const below = (path: string) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);

describe("every page below a path prefix", () => {
  let instance: HttpPrefixedTestInstance;
  let cookie: string;
  let agendaPath: string;
  beforeEach(async () => {
    instance = await bootHttpForTestBelow(prefix, {}, { sourcePlugins: [{ sourceTypeId: "school" }] });
    await instance.core.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    await instance.app.sourceTypes.enable("school");
    await instance.app.sources.add({ sourceTypeId: "school", plain: { url: "https://school.example.org" }, secrets: {} });
    const mia = await instance.app.familyMembers.add({ name: "Mia", photo: photos.png });
    if (!mia.ok) throw new Error("adding Mia failed");
    const agenda = await instance.app.agendas.create({ memberIds: [], horizonDays: 3 });
    if (!agenda.ok) throw new Error("creating the Agenda failed");
    const list = await instance.app.agendas.create({ memberIds: [mia.id], horizonDays: 3, layout: "task_list" });
    if (!list.ok) throw new Error("creating the Task List failed");
    agendaPath = `${prefix}/agendas/${agenda.id}`;
    await seedTasks((sql) => instance.query(sql), { key: "kit", title: "Bring sports kit", deadline: "2026-09-14", sentAt: "2026-09-10T10:00:00Z" });
    const signedIn = await instance.post(`${prefix}/admin/sign-in`, { email: "anna@example.org", password });
    cookie = signedIn.headers.getSetCookie().find((c) => c.startsWith("fb_session="))?.split(";")[0] ?? "";
  });
  afterEach(async () => {
    await instance.close();
  });

  /**
   * Opens `start` and every page, fragment and file of this Instance it leads to, and returns each
   * address one of them emits outside the prefix: in its markup, its redirect or its cookies.
   */
  const crawl = async (start: string[], headers: Record<string, string> = {}) => {
    const outside: string[] = [];
    const seen = new Set<string>(start);
    const queue = [...start];
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const visit = (address: string, what: string) => {
        const target = pathOf(address, path);
        if (target === undefined) return;
        if (!below(target)) outside.push(`${path} ${what} ${address}`);
        else if (!seen.has(target) && !target.includes("/sign-out") && seen.size < 500) {
          seen.add(target);
          queue.push(target);
        }
      };
      const response = await instance.get(path, { cookie, headers });
      for (const name of ["location", "hx-redirect", "hx-location", "hx-push-url"]) {
        const value = response.headers.get(name);
        if (value !== null) visit(value, name);
      }
      for (const set of response.headers.getSetCookie()) {
        const cookiePath = /;\s*Path=([^;]*)/i.exec(set)?.[1];
        if (cookiePath !== undefined && !below(cookiePath)) outside.push(`${path} set-cookie ${set}`);
      }
      if (!(response.headers.get("content-type") ?? "").includes("text/html")) continue;
      for (const { attribute, value } of addressesIn(await response.text())) {
        // A form that posts is checked, not submitted: it would change what the crawl sees.
        if (attribute === "action" || attribute.startsWith("hx-") && attribute !== "hx-get") {
          const target = pathOf(value, path);
          if (target !== undefined && !below(target)) outside.push(`${path} ${attribute} ${value}`);
        } else visit(value, attribute);
      }
    }
    return { outside, seen };
  };

  it("finds no address outside the prefix in the Admin area", async () => {
    const { outside, seen } = await crawl([`${prefix}/admin`]);
    expect(outside).toEqual([]);
    for (const page of ["/admin/admins", "/admin/family-members", "/admin/agendas", "/admin/sources", "/static/design.css"]) {
      expect([...seen].some((path) => path.startsWith(prefix + page)), page).toBe(true);
    }
  });

  it("finds no address outside the prefix in an Agenda and what it loads", async () => {
    const { outside, seen } = await crawl([agendaPath]);
    expect(outside).toEqual([]);
    expect([...seen].some((path) => path.startsWith(`${agendaPath}/days?`))).toBe(true);
    expect([...seen].some((path) => path.startsWith(`${agendaPath}/manifest.webmanifest`))).toBe(true);
  });

  it("finds no address outside the prefix in the fragments htmx swaps in", async () => {
    const { outside } = await crawl([`${prefix}/admin`, agendaPath], { "hx-request": "true" });
    expect(outside).toEqual([]);
  });
});
