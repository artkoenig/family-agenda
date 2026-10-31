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

describe("Events in an Agenda over HTTP", () => {
  let instance: HttpTestInstance;
  let path: string;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "timeline-cal", displayName: { en: "School calendar", de: "Schulkalender" } }] });
    await instance.post("/setup", { email: "anna@example.org", password: "correct horse battery" });
    await instance.app.sourceTypes.enable("timeline-cal");
    await instance.app.sources.add({ sourceTypeId: "timeline-cal", plain: { url: "https://calendar.example.org" }, secrets: {} });
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");
    path = `/agendas/${created.id}`;
  });
  afterEach(async () => {
    await instance.close();
  });

  const arrive = async (...origins: Origin[]) => {
    testPluginControls.emit("timeline-cal", origins);
    await instance.app.polling.pollDue();
  };

  /** The row of the Event with the given title, from `<div class="fam-item` to `</div>`. */
  const rowOf = (page: string, title: string) =>
    new RegExp(`<div class="fam-item[^"]*">(?:(?!</div>).)*${title}(?:(?!</div>).)*</div>`, "s").exec(page)?.[0] ?? "";

  it("shows Events as rows like Tasks, without what their day already says", async () => {
    await arrive(
      event(
        "piano",
        { title: "Piano lesson", span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" }, place: "Music school" },
        { link: "https://calendar.example.org/event/piano" },
      ),
      event("trip", { title: "Class trip", span: { allDay: true, firstDay: "2026-09-16", lastDay: "2026-09-16" } }),
      event("camp", { title: "Summer camp", span: { allDay: true, firstDay: "2026-09-15", lastDay: "2026-09-17" } }),
    );

    const page = await (await instance.get(path)).text();

    const piano = rowOf(page, "Piano lesson");
    expect(piano).toMatch(/<span class="fam-item__lead">16:00 – 17:00<\/span>.*Piano lesson/s);
    expect(piano).not.toContain("Tue 15 Sept");
    expect(piano).toContain('<span class="fam-item__meta">Music school</span>');
    expect(piano).toContain(
      '<span class="fam-item__meta"><a href="https://calendar.example.org/event/piano" rel="noreferrer" target="_blank">School calendar</a></span>',
    );
    expect(piano).not.toContain("<details");
    const trip = rowOf(page, "Class trip");
    expect(trip).toContain("All day");
    expect(trip).not.toContain("Until");
    // An Event that goes on after its day says until when, but not on its last day.
    const camp = (date: string) => rowOf(page.slice(page.indexOf(`data-date="${date}"`)), "Summer camp");
    expect(camp("2026-09-15")).toContain("Until Thu 17 Sept");
    expect(camp("2026-09-17")).not.toContain("Until");
    expect(page.indexOf("Piano lesson")).toBeLessThan(page.indexOf("Class trip"));
  });

  it("shows on each row the avatars of the Family Members it concerns, none for the whole Family", async () => {
    const mia = await instance.app.familyMembers.add({ name: "Mia" });
    if (!mia.ok) throw new Error("adding failed");
    const [source] = await instance.app.sources.list();
    if (!source) throw new Error("no Source");
    const span = { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" };
    await arrive(event("piano", { title: "Piano lesson", span }));
    expect(rowOf(await (await instance.get(path)).text(), "Piano lesson")).not.toContain("fam-event__who");

    await instance.app.sources.assign(source.id, [mia.id]);
    const page = await (await instance.get(path)).text();

    expect(rowOf(page, "Piano lesson")).toMatch(/<span class="fam-event__who" aria-label="Mia" role="img">.*>M<\/span>/s);
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

    expect(rowOf(page, "School breakfast")).toContain('class="fam-item fam-item--earlier"');
    expect(rowOf(page, "Dentist")).toContain('class="fam-item fam-item--cancelled"');
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
    expect(rowOf(further, "Swimming")).toContain('class="fam-item fam-item--earlier"');
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
    expect((await instance.get("/agendas/00000000-0000-4000-8000-000000000000/days?from=2026-09-11&until=2026-09-13&then=later")).status).toBe(404);
  });

  it("serves the Agenda's feed as a calendar, without signing in", async () => {
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

  it("serves no feed for an unknown Agenda or one the listener's policy refuses", async () => {
    expect((await instance.get("/agendas/00000000-0000-4000-8000-000000000000/feed.ics")).status).toBe(404);

    const refusing = createHttpApp(instance.app, { trustProxy: false, agendaAccess: { mayOpen: () => Promise.resolve(false) } });
    expect((await refusing.request(`${path}/feed.ics`)).status).toBe(404);
  });
});
