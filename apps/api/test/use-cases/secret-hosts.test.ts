import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAllowlistApp } from "../../src/egress/allowlist-server";
import { singleFamily } from "../../src/egress/single-family";
import { mintTicket, verifyTicket } from "../../src/egress/ticket";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls } from "../support/test-source-plugin";

const ticketKey = "a-ticket-key-of-at-least-32-characters";

describe("the egress allowlist of an Instance's Sources", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest({ egressTicketKey: ticketKey });
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

  /**
   * What the proxy of the ics plugin may reach with the ticket of its next poll of `sourceId`, or the
   * status of the refusal; for the ticket's claims made out to `familyId`, if given.
   */
  const allowed = async (sourceId: string, familyId?: string) => {
    instance.clock.advance(60 * 60 * 1000);
    await instance.app.polling.pollDue();
    const tickets = testPluginControls.runs("ics").map((run) => verifyTicket(ticketKey, decodeURIComponent(new URL(run.egressProxy).password), Date.now()));
    const minted = tickets.findLast((ticket) => ticket?.sourceId === sourceId);
    if (!minted) throw new Error("that Source was not polled");
    const ticket = mintTicket(ticketKey, { ...minted, familyId: familyId ?? minted.familyId });
    const app = createAllowlistApp({ ticketKey, declared: new Map([["plugin-ics", ["declared.example:443"]]]), family: singleFamily(instance.app) });
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

  it("refuses a ticket of another Family", async () => {
    const id = await add("https://first.example.org/feed");
    expect(await allowed(id, "another-family")).toBe(403);
  });
});
