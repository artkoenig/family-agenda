import { describe, expect, it } from "vitest";
import { describeSourcePluginContract } from "@family-agenda/source-sdk/testing";
import { testPluginControls, testSourcePlugin } from "../support/test-source-plugin";

const config = { plain: { url: "https://example.org" }, secrets: {} };

describeSourcePluginContract(() => testSourcePlugin({ sourceTypeId: "contract" }), { config });

describe("the test plugin", () => {
  const poll = (sourceTypeId: string, state: string | null) => {
    const { ingestion } = testSourcePlugin({ sourceTypeId });
    if (ingestion.mode !== "polling") throw new Error("the test plugin polls");
    return ingestion.poll({ config, state, now: new Date(), timeZone: "Europe/Berlin" });
  };

  it("emits the Origins it is given, once, and advances its state", async () => {
    const origin = {
      externalId: "mail-1",
      occurredAt: new Date("2026-09-14T07:00:00Z"),
      attributes: { sender: "school@example.org" },
      content: { kind: "raw-message" as const, text: "Trip on Friday", attachments: [] },
    };
    testPluginControls.emit("emitting", [origin]);

    expect(await poll("emitting", null)).toEqual({ origins: [origin], state: "1" });
    expect(await poll("emitting", "1")).toEqual({ origins: [], state: "2" });
  });

  it("fails on demand with a definite or temporary error", async () => {
    testPluginControls.failNext("failing", "definite");
    await expect(poll("failing", null)).rejects.toMatchObject({ kind: "definite" });
    testPluginControls.failNext("failing", "temporary");
    await expect(poll("failing", null)).rejects.toMatchObject({ kind: "temporary" });
    expect((await poll("failing", null)).origins).toEqual([]);
  });
});
