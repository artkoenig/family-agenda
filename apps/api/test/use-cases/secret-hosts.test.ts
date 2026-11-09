import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceTypeId } from "@family-agenda/domain";
import { bootForTest, type TestInstance } from "../support/boot";

const ics = "ics" as SourceTypeId;

describe("the host of a secret address", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
    await instance.installPlugin({
      sourceTypeId: "ics",
      configuration: { version: 1, fields: [{ key: "url", label: "Address", secret: true, required: true, host: true }] },
    });
    await instance.restart();
    await instance.app.sourceTypes.enable("ics");
  });
  afterEach(async () => {
    await instance.close();
  });

  it("is allowed out as the Admin enters the address, without its token, and follows a new one", async () => {
    const added = await instance.app.sources.add({ sourceTypeId: "ics", plain: {}, secrets: { url: "webcal://calendar.google.com/calendar/ical/x/private-abc/basic.ics" } });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);

    expect(await instance.app.egressHosts.ofSourceType(ics)).toEqual(["calendar.google.com"]);

    await instance.app.sources.edit(added.id, { plain: {}, secrets: { url: "" } });
    expect(await instance.app.egressHosts.ofSourceType(ics)).toEqual(["calendar.google.com"]);

    await instance.app.sources.edit(added.id, { plain: {}, secrets: { url: "https://cal.example.org/feed?token=t" } });
    expect(await instance.app.egressHosts.ofSourceType(ics)).toEqual(["cal.example.org"]);
  });
});
