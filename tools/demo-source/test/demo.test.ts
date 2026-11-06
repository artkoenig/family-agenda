import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeSourcePluginContract, recordingAttributes, undeclaredAttributes } from "@family-agenda/source-sdk/testing";
import type { IngestContext, IngestResult, Origin, SourcePlugin, StatedItem } from "@family-agenda/source-sdk";
import { SourceRegistry } from "../../../apps/api/src/source-registry";
import { createDemoPlugin } from "../src";

const packageJson: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const config = { plain: {}, secrets: {} };
// A Monday morning.
const now = new Date("2026-09-14T07:00:00Z");

const poll = (plugin: SourcePlugin, context: Partial<IngestContext> = {}): Promise<IngestResult> => {
  if (plugin.ingestion.mode !== "polling") throw new Error("the demo plugin polls");
  return plugin.ingestion.poll({ config, syncCursor: null, now, timeZone: "Europe/Berlin", attributes: recordingAttributes(), ...context });
};

const statedItems = (origins: Origin[]): StatedItem[] => origins.flatMap((origin) => (origin.content.kind === "stated" ? [origin.content.stated] : []));

describeSourcePluginContract(() => createDemoPlugin(), { config, now, languages: ["de"], packageJson });

describe("the demo plugin", () => {
  it("states both Events and Lessons, so every Agenda has something to show", async () => {
    const { origins } = await poll(createDemoPlugin());

    const kinds = new Set(statedItems(origins).map((item) => item.kind));
    expect([...kinds].sort()).toEqual(["event", "lesson"]);
  });

  it("starts on the day of the run, in the Family's time zone", async () => {
    const { origins } = await poll(createDemoPlugin());

    const firstLesson = origins.find((origin) => origin.externalId === "lesson-2026-09-14-1");
    // 08:00 in Berlin, which is two hours ahead of UTC in September.
    expect(firstLesson?.content).toMatchObject({ stated: { kind: "lesson", subject: "Mathematics", span: { start: "2026-09-14T06:00:00.000Z", end: "2026-09-14T06:45:00.000Z" } } });
  });

  it("follows the date of the run, so an Agenda is never empty", async () => {
    const { origins } = await poll(createDemoPlugin(), { now: new Date("2027-01-06T07:00:00Z") });

    // Winter time: 08:00 in Berlin is 07:00 UTC. The 6th of January 2027 is a Wednesday, so its first lesson is substituted.
    expect(origins.find((origin) => origin.externalId === "lesson-2027-01-06-1")?.content).toMatchObject({
      stated: { span: { start: "2027-01-06T07:00:00.000Z" }, change: "substitution", teacher: "Mr Braun", previousTeacher: "Ms Weber" },
    });
    expect(origins.some((origin) => origin.externalId.includes("2026-09"))).toBe(false);
  });

  it("states the same Origins when it runs again, so a re-run changes nothing", async () => {
    const first = await poll(createDemoPlugin());
    const second = await poll(createDemoPlugin());

    expect(second.origins).toEqual(first.origins);
    expect(new Set(first.origins.map((origin) => origin.externalId)).size).toBe(first.origins.length);
  });

  it("declares every Source Attribute its Origins name", async () => {
    expect(await undeclaredAttributes(createDemoPlugin(), config, now)).toEqual([]);
  });

  it("is not among the Source Types an Instance finds on its own, so the image never offers it", async () => {
    const shipped = fileURLToPath(new URL("../../../packages", import.meta.url));

    const registry = await SourceRegistry.discover([shipped]);

    expect(registry.installed().map((type) => type.id)).toEqual(expect.arrayContaining(["ics"]));
    expect(registry.installed().map((type) => type.id)).not.toContain("demo");
  });
});
