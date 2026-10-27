import type { Origin } from "@family-agenda/source-sdk";
import ICAL from "ical.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpApp } from "../../src/http/app";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";
import { testPluginControls } from "../support/test-source-plugin";

/** A created Event, as a calendar Source emits it. */
const event = (key: string, fields: Record<string, unknown>, more: Partial<Origin> = {}): Origin => ({
  externalId: key,
  occurredAt: new Date("2026-09-01T10:00:00Z"),
  attributes: {},
  content: { kind: "revisions", revisions: [{ itemKind: "event", itemKey: key, action: "create", fields: fields as never }] },
  ...more,
});

describe("Events in a View over HTTP", () => {
  let instance: HttpTestInstance;
  let path: string;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "timeline-cal" }] });
    await instance.post("/setup", { email: "anna@example.org", password: "correct horse battery" });
    await instance.app.sourceTypes.enable("timeline-cal");
    await instance.app.sources.add({ sourceTypeId: "timeline-cal", plain: { url: "https://calendar.example.org" }, secrets: {} });
    const created = await instance.app.views.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    path = `/views/${created.id}`;
  });
  afterEach(async () => {
    await instance.close();
  });

  const arrive = async (...origins: Origin[]) => {
    testPluginControls.emit("timeline-cal", origins);
    await instance.app.polling.pollDue();
  };

  /** The row of the Event with the given title, from `<details>` to `</details>`. */
  const rowOf = (page: string, title: string) =>
    new RegExp(`<details[^>]*>(?:(?!</details>).)*${title}(?:(?!</details>).)*</details>`, "s").exec(page)?.[0] ?? "";

  it("shows Events as compact rows with their details on tap", async () => {
    await arrive(
      event(
        "piano",
        { title: "Piano lesson", span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" }, place: "Music school" },
        { link: "https://calendar.example.org/event/piano" },
      ),
      event("trip", { title: "Class trip", span: { allDay: true, firstDay: "2026-09-16", lastDay: "2026-09-16" } }),
    );

    const page = await (await instance.get(path)).text();

    const piano = rowOf(page, "Piano lesson");
    expect(piano).toMatch(/<summary[^>]*>.*16:00.*Piano lesson.*<\/summary>/s);
    expect(piano).toContain("Tue 15 Sept, 16:00 – 17:00");
    expect(piano).toContain("Music school");
    expect(piano).toContain('<a href="https://calendar.example.org/event/piano" rel="noreferrer" target="_blank">');
    expect(rowOf(page, "Class trip")).toContain("All day");
    expect(page.indexOf("Piano lesson")).toBeLessThan(page.indexOf("Class trip"));
  });

  it("strikes cancelled Events through and dims those of today that are over", async () => {
    await arrive(
      event("breakfast", { title: "School breakfast", span: { allDay: false, start: "2026-09-14T05:30:00Z", end: "2026-09-14T06:30:00Z" } }),
      event("dentist", { title: "Dentist", span: { allDay: false, start: "2026-09-14T13:00:00Z", end: "2026-09-14T13:30:00Z" } }),
    );
    testPluginControls.emit("timeline-cal", [
      {
        ...event("dentist", {}),
        occurredAt: new Date("2026-09-02T10:00:00Z"),
        content: { kind: "revisions", revisions: [{ itemKind: "event", itemKey: "dentist", action: "cancel", fields: {} }] },
      },
    ]);
    instance.clock.advance(10 * 60 * 1000);
    await instance.app.polling.pollDue();

    const page = await (await instance.get(path)).text();

    expect(rowOf(page, "School breakfast")).toContain('class="event earlier"');
    expect(rowOf(page, "Dentist")).toContain('class="event cancelled"');
    expect(rowOf(page, "Dentist")).toContain("<s>Dentist</s>");
    // The "now" line comes after what is over.
    expect(page.indexOf("School breakfast")).toBeLessThan(page.indexOf("Now 09:10"));
    expect(page.indexOf("Now 09:10")).toBeLessThan(page.indexOf("Dentist"));
    expect(page).toContain("Nothing planned.");
  });

  it("scrolls into the past and the future, one horizon at a time", async () => {
    await arrive(
      event("swim", { title: "Swimming", span: { allDay: false, start: "2026-09-10T14:00:00Z", end: "2026-09-10T15:00:00Z" } }),
      event("fair", { title: "School fair", span: { allDay: true, firstDay: "2026-09-18", lastDay: "2026-09-18" } }),
    );

    const page = await (await instance.get(path)).text();
    expect(page).not.toContain("Swimming");
    expect(page).not.toContain("School fair");
    const earlierUrl = `${path}/days?show=all&amp;from=2026-09-11&amp;until=2026-09-13&amp;then=earlier`;
    const laterUrl = `${path}/days?show=all&amp;from=2026-09-17&amp;until=2026-09-19&amp;then=later`;
    expect(page).toContain(`hx-get="${earlierUrl}"`);
    expect(page).toMatch(new RegExp(`hx-get="${laterUrl.replaceAll("?", "\\?")}" hx-trigger="revealed"`));

    const later = await (await instance.get(laterUrl.replaceAll("&amp;", "&"))).text();
    expect(later).toContain("School fair");
    expect(later).toContain(`from=2026-09-20&amp;until=2026-09-22&amp;then=later`);
    expect(later).not.toContain("Earlier days");
    expect(later).toContain('<input type="hidden" id="shown-until" name="until" value="2026-09-19" hx-swap-oob="true"/>');

    const earlier = await (await instance.get(earlierUrl.replaceAll("&amp;", "&"))).text();
    expect(earlier).toContain('data-date="2026-09-13"');
    expect(earlier).toContain("Yesterday");
    expect(earlier).toContain(`from=2026-09-08&amp;until=2026-09-10&amp;then=earlier`);
    expect(earlier).not.toContain("Now ");
    expect(earlier).toContain('<input type="hidden" id="shown-from" name="from" value="2026-09-11" hx-swap-oob="true"/>');
    const further = await (await instance.get(`${path}/days?show=all&from=2026-09-08&until=2026-09-10&then=earlier`)).text();
    expect(rowOf(further, "Swimming")).toContain('class="event earlier"');
  });

  it("refreshes the days scrolled to, and refuses days it cannot show", async () => {
    const refreshed = await (await instance.get(`${path}?show=all&from=2026-09-11&until=2026-09-19`)).text();
    expect(refreshed).toContain('data-date="2026-09-11"');
    expect(refreshed).toContain('data-date="2026-09-19"');
    expect(refreshed.indexOf("Today")).toBeGreaterThan(refreshed.indexOf('data-date="2026-09-13"'));
    expect(refreshed).toContain("Now 09:00");

    for (const query of ["from=2026-09-11", "from=2026-02-30&until=2026-03-01", "from=2026-09-19&until=2026-09-11", "from=2026-01-01&until=2027-12-31"]) {
      expect((await instance.get(`${path}?${query}`)).status).toBe(400);
    }
    expect((await instance.get(`${path}/days?from=2026-09-11&until=2026-09-13`)).status).toBe(400);
    expect((await instance.get("/views/00000000-0000-4000-8000-000000000000/days?from=2026-09-11&until=2026-09-13&then=later")).status).toBe(404);
  });

  it("serves the View's feed as a calendar, without signing in", async () => {
    const place = "Großer Saal der Musikschule; Eingang über den Hof, zweite Tür links, dann die Treppe hinauf";
    await arrive(
      event("concert", {
        title: "Concert, with \\ and ; and \nmore",
        span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" },
        place,
      }),
    );

    const response = await instance.get(`${path}/feed.ics`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    const body = await response.text();
    expect(body.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
    const [vevent] = new ICAL.Component(ICAL.parse(body) as unknown[]).getAllSubcomponents("vevent");
    expect(vevent?.getFirstPropertyValue("summary")).toBe("Concert, with \\ and ; and \nmore");
    expect(vevent?.getFirstPropertyValue("location")).toBe(place);
    expect(vevent?.getFirstPropertyValue("url")).toBe(`http://localhost${path}`);
  });

  it("serves no feed for an unknown View or one the listener's policy refuses", async () => {
    expect((await instance.get("/views/00000000-0000-4000-8000-000000000000/feed.ics")).status).toBe(404);

    const refusing = createHttpApp(instance.app, { trustProxy: false, viewAccess: { mayOpen: () => Promise.resolve(false) } });
    expect((await refusing.request(`${path}/feed.ics`)).status).toBe(404);
  });
});
