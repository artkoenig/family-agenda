import { describe, expect, it } from "vitest";
import { proxySettingsOf, staticAllowlist, ticketAllowlist } from "../../src/egress/allowlist-client";
import { createAllowlistApp } from "../../src/egress/allowlist-server";
import { mintTicket, type Ticket } from "../../src/egress/ticket";

const key = "a-ticket-key-of-at-least-32-characters";
const now = 1_000_000;
const claims = (changes: Partial<Ticket> = {}): Ticket => ({ familyId: "family-a", sourceTypeId: "imap", sourceId: "source-1", expiresAt: now + 1, hosts: null, ...changes });

describe("ticketAllowlist", () => {
  const answering = (answer: () => Response) => {
    const seen: RequestInit[] = [];
    const fetchFn: typeof fetch = (_url, init) => {
      seen.push(init ?? {});
      return Promise.resolve(answer());
    };
    return { seen, allowlist: ticketAllowlist({ url: "http://api:3001/egress/plugin-imap", ticketKey: key }, fetchFn, () => now) };
  };

  it("fetches the hosts with the ticket the call presented", async () => {
    const { seen, allowlist } = answering(() => Response.json({ hosts: ["a.example:443"] }));
    const ticket = mintTicket(key, claims());

    expect(await allowlist(ticket)).toEqual(["a.example:443"]);
    expect(seen[0]?.headers).toEqual({ authorization: `Bearer ${ticket}` });
  });

  it("refuses, without asking the api, a connection without a ticket, or with an expired or forged one", async () => {
    const { seen, allowlist } = answering(() => Response.json({ hosts: ["a.example:443"] }));

    expect(await allowlist(null)).toBeNull();
    expect(await allowlist(mintTicket(key, claims({ expiresAt: now })))).toBeNull();
    expect(await allowlist(mintTicket("another-ticket-key-of-at-least-32-chars", claims()))).toBeNull();
    expect(seen).toEqual([]);
  });

  it.each([401, 403])("refuses a ticket the api answers %i for", async (status) => {
    const { allowlist } = answering(() => new Response("no", { status }));
    expect(await allowlist(mintTicket(key, claims()))).toBeNull();
  });

  it.each([
    ["another failure", () => new Response("down", { status: 500 })],
    ["no list", () => Response.json({ hosts: "a.example" })],
    ["a list of non-strings", () => Response.json({ hosts: [1] })],
  ])("rejects %s", async (_, answer) => {
    await expect(answering(answer).allowlist(mintTicket(key, claims()))).rejects.toThrow();
  });

  it("is served by the allowlist server the hosts of the ticket's Source alone", async () => {
    const app = createAllowlistApp({
      ticketKey: key,
      declared: new Map([["plugin-imap", ["login.example.com:443"]]]),
      family: (familyId) => Promise.resolve(familyId === "family-a" ? { hostsOf: (sourceId) => Promise.resolve(sourceId === "source-1" ? ["imap.example.org"] : null) } : null),
      now: () => now,
    });
    const allowlist = ticketAllowlist({ url: "http://api:3001/egress/plugin-imap", ticketKey: key }, (url, init) => Promise.resolve(app.request(url, init)), () => now);

    expect(await allowlist(mintTicket(key, claims()))).toEqual(["login.example.com:443", "imap.example.org"]);
    expect(await allowlist(mintTicket(key, claims({ sourceId: "source-2" })))).toBeNull();
    expect(await allowlist(mintTicket(key, claims({ familyId: "family-b" })))).toBeNull();
  });
});

describe("staticAllowlist", () => {
  it("allows a companion its declared hosts, without a ticket", async () => {
    expect(await staticAllowlist(["*.whatsapp.net:443"])(null)).toEqual(["*.whatsapp.net:443"]);
  });
});

describe("proxySettingsOf", () => {
  it("reads the settings of a plugin's own proxy, which takes tickets, with the default port", () => {
    expect(proxySettingsOf({ EGRESS_ALLOWLIST_URL: "u", EGRESS_TICKET_KEY: "k" })).toEqual({ port: 3128, allowlist: { url: "u", ticketKey: "k" } });
    expect(proxySettingsOf({ EGRESS_ALLOWLIST_URL: "u", EGRESS_TICKET_KEY: "k", PORT: "9" }).port).toBe(9);
  });

  it("reads the hosts of a companion's proxy", () => {
    expect(proxySettingsOf({ EGRESS_HOSTS: " a.example:443 ;*.b.example:443;" })).toEqual({ port: 3128, allowlist: { hosts: ["a.example:443", "*.b.example:443"] } });
  });

  it("requires the url with the ticket key, or the hosts", () => {
    expect(() => proxySettingsOf({ EGRESS_TICKET_KEY: "k" })).toThrow(/EGRESS_ALLOWLIST_URL/);
    expect(() => proxySettingsOf({ EGRESS_ALLOWLIST_URL: "u" })).toThrow(/EGRESS_TICKET_KEY/);
    expect(() => proxySettingsOf({})).toThrow(/EGRESS_ALLOWLIST_URL/);
  });
});
