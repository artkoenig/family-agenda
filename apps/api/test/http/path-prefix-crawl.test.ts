import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressAttributes, redirectHeaders } from "../../src/http/addresses";
import { bootHttpForTestBelow, type HttpPrefixedTestInstance } from "../support/http";
import { photos } from "../support/photos";
import { seedTasks } from "../support/seed-task";

const password = "correct horse battery";
const prefix = "/agenda";
const origin = "http://localhost";

/** Every address a page names: in a link, a source, a form, a background request or a redirect of htmx. */
const addressesIn = (body: string) =>
  [...body.matchAll(new RegExp(`\\s(${addressAttributes.join("|")})="([^"]*)"`, "g"))].map(
    ([, attribute = "", value = ""]) => ({ attribute, value: value.replaceAll("&amp;", "&") }),
  );

/** The path an address leads to on this Instance, or undefined for one elsewhere (or a fragment, `mailto:`, `data:`, …). */
const pathOf = (address: string, base: string): string | undefined => {
  if (address === "" || address.startsWith("#") || /^(mailto|tel|data|webcal|javascript):/i.test(address)) return undefined;
  const url = new URL(address, origin + base);
  return url.origin === origin ? url.pathname + url.search : undefined;
};

const below = (path: string) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);

/**
 * What one page of a kind is opened for: its path and the names of its query, not their values, so
 * that paging through an Agenda's days (`days?from=…&until=…`), which never ends, is opened once.
 */
const kindOf = (path: string) => {
  const url = new URL(path, origin);
  return `${url.pathname}?${[...new Set(url.searchParams.keys())].sort().join("&")}`;
};

/** The most kinds of address one crawl opens; reaching it fails the test, so that no page goes unchecked. */
const crawlCap = 500;
/** Addresses the crawl does not open, since opening them would end the session it crawls with. */
const leavesTheSession = (path: string) => path.includes("/sign-out");

/** Each address a response sends the browser to outside the prefix: a redirect of HTTP or htmx, or a cookie path. */
const redirectsOutside = (response: Response, from: string) => {
  const outside: string[] = [];
  for (const name of redirectHeaders) {
    const value = response.headers.get(name);
    const target = value === null ? undefined : pathOf(value, from);
    if (target !== undefined && !below(target)) outside.push(`${from} ${name} ${value ?? ""}`);
  }
  for (const set of response.headers.getSetCookie()) {
    const cookiePath = /;\s*Path=([^;]*)/i.exec(set)?.[1];
    if (cookiePath === undefined || !below(cookiePath)) outside.push(`${from} set-cookie ${set}`);
  }
  return outside;
};

/** The `name=value` pair of a cookie a response sets. */
const cookieOf = (response: Response, name: string) =>
  response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";

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
    cookie = cookieOf(signedIn, "fb_session");
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
    const seen = new Set<string>(start.map(kindOf));
    const queue = [...start];
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const visit = (address: string, what: string) => {
        const target = pathOf(address, path);
        if (target === undefined) return;
        if (!below(target)) outside.push(`${path} ${what} ${address}`);
        else if (!seen.has(kindOf(target)) && !leavesTheSession(target) && seen.size < crawlCap) {
          seen.add(kindOf(target));
          queue.push(target);
        }
      };
      const response = await instance.get(path, { cookie, headers });
      outside.push(...redirectsOutside(response, path));
      const location = response.headers.get("location");
      if (location !== null) visit(location, "location");
      if (!(response.headers.get("content-type") ?? "").includes("text/html")) continue;
      for (const { attribute, value } of addressesIn(await response.text())) {
        // A form that posts is checked, not submitted: it would change what the crawl sees.
        if (attribute === "action" || attribute.startsWith("hx-") && attribute !== "hx-get") {
          const target = pathOf(value, path);
          if (target !== undefined && !below(target)) outside.push(`${path} ${attribute} ${value}`);
        } else visit(value, attribute);
      }
    }
    expect(seen.size, "the crawl reached its cap").toBeLessThan(crawlCap);
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

describe("setting up and signing in below a path prefix", () => {
  let instance: HttpPrefixedTestInstance;
  afterEach(async () => {
    await instance.close();
  });

  /** The address a form on `page` posts to, below the prefix. */
  const actionOf = (page: string, form: RegExp) => {
    const action = [...page.matchAll(/action="([^"]*)"/g)].map(([, a = ""]) => a.replaceAll("&amp;", "&")).find((a) => form.test(a));
    if (action === undefined) throw new Error(`no form posts to ${String(form)}`);
    expect(below(action), action).toBe(true);
    return action;
  };
  /** Opens a page, and checks the page and its response for addresses outside the prefix. */
  const opened = async (path: string, cookie = "") => {
    const response = await instance.get(path, { cookie });
    expect(redirectsOutside(response, path)).toEqual([]);
    const page = await response.text();
    const outside = addressesIn(page)
      .map(({ value }) => pathOf(value, path))
      .filter((target) => target !== undefined && !below(target));
    expect(outside, path).toEqual([]);
    return { response, page };
  };
  /** Posts a form, checks its redirect and cookies, and returns where it leads. */
  const submitted = async (action: string, form: Record<string, string>, cookie = "") => {
    const response = await instance.post(action, form, { cookie });
    expect(redirectsOutside(response, action)).toEqual([]);
    const location = response.headers.get("location") ?? "";
    expect(below(location), location).toBe(true);
    return { response, location };
  };

  it("keeps setup, the Recovery Kit, signing in and out below the prefix", async () => {
    instance = await bootHttpForTestBelow(prefix);
    const first = await opened(`${prefix}/admin`);
    expect(first.response.headers.get("location")).toBe(`${prefix}/setup`);
    const setup = await opened(`${prefix}/setup`);
    const created = await submitted(actionOf(setup.page, /\/setup$/), { email: "anna@example.org", password });
    const session = cookieOf(created.response, "fb_session");
    expect(session).not.toBe("");
    expect(created.location).toBe(`${prefix}/admin/recovery-kit`);

    const kit = await opened(created.location, session);
    const confirmed = await submitted(actionOf(kit.page, /\/recovery-kit\/confirm$/), { saved: "yes" }, session);
    expect(confirmed.location).toBe(`${prefix}/admin`);
    const admin = await opened(confirmed.location, session);
    expect(admin.response.status).toBe(200);

    const signedOut = await submitted(actionOf(admin.page, /\/sign-out$/), {}, session);
    expect(signedOut.location).toBe(`${prefix}/admin/sign-in`);
    const signIn = await opened(signedOut.location);
    const signedIn = await submitted(actionOf(signIn.page, /\/sign-in$/), { email: "anna@example.org", password });
    expect(signedIn.location).toBe(`${prefix}/admin`);
    expect((await opened(signedIn.location, cookieOf(signedIn.response, "fb_session"))).response.status).toBe(200);
  });
});
