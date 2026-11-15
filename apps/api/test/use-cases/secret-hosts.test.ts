import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ticketAllowlist } from "../../src/egress/proxy-allowlist";
import { mintTicket, verifyTicket } from "../../src/egress/ticket";
import { bootForTest, type TestInstance } from "../support/boot";
import { testPluginControls } from "../support/test-source-plugin";

const ticketKey = "a-ticket-key-of-at-least-32-characters";

describe("what the egress proxy allows for an Instance's Sources", () => {
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

  /** What the proxy of the ics plugin may reach with the ticket of its next poll of `sourceId`. */
  const allowed = async (sourceId: string) => {
    instance.clock.advance(60 * 60 * 1000);
    await instance.app.polling.pollDue();
    const tickets = testPluginControls.runs("ics").map((run) => verifyTicket(ticketKey, decodeURIComponent(new URL(run.egressProxy).password), Date.now()));
    const minted = tickets.findLast((ticket) => ticket?.sourceId === sourceId);
    if (!minted) throw new Error("that Source was not polled");
    return ticketAllowlist({ service: "plugin-ics", hosts: ["declared.example:443"], ticketKey })(mintTicket(ticketKey, minted));
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

});
