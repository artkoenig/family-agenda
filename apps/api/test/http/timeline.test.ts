import type { Origin } from "@family-butler/source-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
