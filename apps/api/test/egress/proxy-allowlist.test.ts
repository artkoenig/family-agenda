import { describe, expect, it } from "vitest";
import { proxySettingsOf, staticAllowlist, ticketAllowlist } from "../../src/egress/proxy-allowlist";
import { mintTicket, type Ticket } from "../../src/egress/ticket";

const key = "a-ticket-key-of-at-least-32-characters";
const now = 1_000_000;

/** The host field values of a Source, as the core writes them into its ticket. */
const sourceHosts = ["IMAP.gmx.net", "login.example.com:443", "*", "*.example.org", "https://evil.example/", "a.example/path", "b.example:0", "c.example:70000", "mail.example:993", " HTTPS://Park.WebUntis.com/WebUntis/?school=x", "webcal://cal.example:8443/feed.ics", "d.example?x#y", "https://*.example.net/", "ftp://e.example"];

const claims = (changes: Partial<Ticket> = {}): Ticket => ({ familyId: "family-a", sourceTypeId: "imap", sourceId: "source-1", expiresAt: now + 1, hosts: sourceHosts, ...changes });
const ticketFor = (changes: Partial<Ticket> = {}) => mintTicket(key, claims(changes));

describe("ticketAllowlist", () => {
  const allowlistOf = (service: string) => ticketAllowlist({ service, hosts: ["login.example.com:443"], ticketKey: key }, () => now);
  const allowlist = allowlistOf("plugin-imap");

  it("allows the declared hosts and the valid hosts the ticket carries for its Source, stripped of scheme and path", () => {
    expect(allowlist(ticketFor())).toEqual([
      "login.example.com:443",
      "imap.gmx.net",
      "evil.example",
      "a.example",
      "mail.example:993",
      "park.webuntis.com",
      "cal.example:8443",
      "d.example",
    ]);
  });

  it("allows each ticket the hosts of its own Source", () => {
    expect(allowlist(ticketFor({ familyId: "family-b", hosts: ["mail.family-b.example"] }))).toEqual(["login.example.com:443", "mail.family-b.example"]);
    expect(allowlist(ticketFor({ sourceId: "source-2", hosts: ["other.example"] }))).toEqual(["login.example.com:443", "other.example"]);
  });

  it("allows only the declared hosts for a call of no Source, such as for the Catalogue entries", () => {
    expect(allowlist(ticketFor({ sourceId: null, hosts: [] }))).toEqual(["login.example.com:443"]);
  });

  it.each([
    ["no ticket", "plugin-imap", () => null],
    ["an expired ticket", "plugin-imap", () => ticketFor({ expiresAt: now })],
    ["a tampered ticket", "plugin-imap", () => `${ticketFor().split(".")[0] ?? ""}.${ticketFor({ sourceId: "source-2" }).split(".")[1] ?? ""}`],
    ["a ticket signed with another key", "plugin-imap", () => mintTicket("another-ticket-key-of-at-least-32-chars", claims())],
    ["a ticket for another plugin", "plugin-ics", () => ticketFor()],
    ["a ticket for a companion", "plugin-imap-helper", () => ticketFor()],
  ])("refuses %s", (_, service, ticket) => {
    expect(allowlistOf(service)(ticket())).toBeNull();
  });
});

describe("staticAllowlist", () => {
  it("allows a companion its declared hosts, without a ticket", () => {
    expect(staticAllowlist(["*.whatsapp.net:443"])(null)).toEqual(["*.whatsapp.net:443"]);
  });
});

describe("proxySettingsOf", () => {
  it("reads the settings of a plugin's own proxy, which takes tickets, with the default port", () => {
    expect(proxySettingsOf({ EGRESS_PLUGIN: "plugin-demo", EGRESS_HOSTS: "a.example:443", EGRESS_TICKET_KEY: "k" })).toEqual({
      port: 3128,
      allowlist: { service: "plugin-demo", hosts: ["a.example:443"], ticketKey: "k" },
    });
    expect(proxySettingsOf({ EGRESS_PLUGIN: "plugin-demo", EGRESS_TICKET_KEY: "k", PORT: "9" })).toEqual({ port: 9, allowlist: { service: "plugin-demo", hosts: [], ticketKey: "k" } });
  });

  it("reads the hosts of a companion's proxy", () => {
    expect(proxySettingsOf({ EGRESS_HOSTS: " a.example:443 ;*.b.example:443;" })).toEqual({ port: 3128, allowlist: { hosts: ["a.example:443", "*.b.example:443"] } });
  });

  it("requires the ticket key with the plugin, or the hosts", () => {
    expect(() => proxySettingsOf({ EGRESS_PLUGIN: "plugin-demo" })).toThrow(/EGRESS_TICKET_KEY/);
    expect(() => proxySettingsOf({ EGRESS_TICKET_KEY: "k" })).toThrow(/EGRESS_PLUGIN/);
    expect(() => proxySettingsOf({})).toThrow(/EGRESS_PLUGIN/);
  });
});
