import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAllowlistApp } from "../../src/egress/allowlist-server";
import { singleFamily } from "../../src/egress/single-family";
import { mintTicket } from "../../src/egress/ticket";
import { bootForTest, type TestInstance } from "../support/boot";

const ticketKey = "a-ticket-key-of-at-least-32-characters";

describe("the egress allowlist of an Instance's Sources", () => {
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

  const add = async (url: string) => {
    const added = await instance.app.sources.add({ sourceTypeId: "ics", plain: {}, secrets: { url } });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    return added.id;
  };

  /** What the proxy of the ics plugin may reach for a call with a ticket for `sourceId`, or the status of the refusal. */
  const allowed = async (sourceId: string, familyId = instance.app.familyId) => {
    const app = createAllowlistApp({ ticketKey, declared: new Map([["plugin-ics", ["declared.example:443"]]]), family: singleFamily(instance.app) });
    const ticket = mintTicket(ticketKey, { familyId, sourceTypeId: "ics", sourceId, expiresAt: Date.now() + 60_000, hosts: null });
    const response = await app.request("/egress/plugin-ics", { headers: { authorization: `Bearer ${ticket}` } });
    return response.ok ? ((await response.json()) as { hosts: string[] }).hosts : response.status;
  };

  it("lets a secret address's host out as the Admin enters it, without its token, and follows a new one", async () => {
    const id = await add("webcal://calendar.google.com/calendar/ical/x/private-abc/basic.ics");
    expect(await allowed(id)).toEqual(["declared.example:443", "calendar.google.com"]);

    await instance.app.sources.edit(id, { plain: {}, secrets: { url: "" } });
    expect(await allowed(id)).toEqual(["declared.example:443", "calendar.google.com"]);

    await instance.app.sources.edit(id, { plain: {}, secrets: { url: "https://cal.example.org/feed?token=t" } });
    expect(await allowed(id)).toEqual(["declared.example:443", "cal.example.org"]);
  });

  it("lets out the hosts of the ticket's Source only, not those of the other Sources of its type", async () => {
    const first = await add("https://first.example.org/feed");
    const second = await add("https://second.example.org/feed");

    expect(await allowed(first)).toEqual(["declared.example:443", "first.example.org"]);
    expect(await allowed(second)).toEqual(["declared.example:443", "second.example.org"]);
  });

  it("refuses a ticket of another Family, or of a removed Source", async () => {
    const id = await add("https://first.example.org/feed");
    expect(await allowed(id, "another-family")).toBe(403);

    await instance.app.sources.remove(id);
    expect(await allowed(id)).toBe(403);
  });
});
