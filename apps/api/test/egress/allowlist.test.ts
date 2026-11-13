import { describe, expect, it } from "vitest";
import { allows, parseEntry, parsePluginEgress } from "../../src/egress/allowlist";
import { createAllowlistApp, type AllowlistDeps } from "../../src/egress/allowlist-server";
import { mintTicket, type Ticket } from "../../src/egress/ticket";

describe("parsePluginEgress", () => {
  it("reads the hosts per container", () => {
    expect(parsePluginEgress(" plugin-demo=api.example.com:443;*.example.org:443 , plugin-demo-x=a.example:80,plugin-demo-x=b.example:80")).toEqual(
      new Map([
        ["plugin-demo", ["api.example.com:443", "*.example.org:443"]],
        ["plugin-demo-x", ["a.example:80", "b.example:80"]],
      ]),
    );
    expect(parsePluginEgress(undefined)).toEqual(new Map());
    expect(parsePluginEgress("")).toEqual(new Map());
  });

  it("rejects an entry without a container", () => {
    expect(() => parsePluginEgress("api.example.com:443")).toThrow(/PLUGIN_EGRESS/);
    expect(() => parsePluginEgress("=api.example.com:443")).toThrow(/PLUGIN_EGRESS/);
  });
});

const key = "a-ticket-key-of-at-least-32-characters";
const now = 1_000_000;

/** Two Families on one Instance, each with Sources of its own; both have a Source `source-1`. */
const families: Record<string, Record<string, { sourceTypeId: string; hosts: string[] }>> = {
  "family-a": {
    "source-1": {
      sourceTypeId: "imap",
      hosts: ["IMAP.gmx.net", "login.example.com:443", "*", "*.example.org", "https://evil.example/", "a.example/path", "b.example:0", "c.example:70000", "mail.example:993", " HTTPS://Park.WebUntis.com/WebUntis/?school=x", "webcal://cal.example:8443/feed.ics", "d.example?x#y", "https://*.example.net/", "ftp://e.example"],
    },
    "source-2": { sourceTypeId: "imap", hosts: ["other.example"] },
    "source-3": { sourceTypeId: "ics", hosts: ["calendar.example"] },
  },
  "family-b": { "source-1": { sourceTypeId: "imap", hosts: ["mail.family-b.example"] } },
};

const deps: AllowlistDeps = {
  ticketKey: key,
  declared: new Map([
    ["plugin-imap", ["login.example.com:443"]],
    ["plugin-imap-helper", ["helper.example.com:443"]],
  ]),
  family: (familyId) => {
    const sources = families[familyId];
    if (sources === undefined) return Promise.resolve(null);
    return Promise.resolve({
      hostsOf: (sourceId, sourceTypeId) => {
        const source = sources[sourceId];
        return Promise.resolve(source?.sourceTypeId === sourceTypeId ? source.hosts : null);
      },
    });
  },
  now: () => now,
};

const claims = (changes: Partial<Ticket> = {}): Ticket => ({ familyId: "family-a", sourceTypeId: "imap", sourceId: "source-1", expiresAt: now + 1, hosts: null, ...changes });
const ticketFor = (changes: Partial<Ticket> = {}) => mintTicket(key, claims(changes));

describe("the allowlist server", () => {
  const app = createAllowlistApp(deps);
  const get = (service: string, authorization?: string) =>
    app.request(`/egress/${service}`, authorization === undefined ? {} : { headers: { authorization } });
  const hostsOf = async (service: string, ticket: string) => {
    const response = await get(service, `Bearer ${ticket}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { hosts: string[] }).hosts;
  };

  it("serves the declared hosts and the valid hosts of the ticket's Source, stripped of scheme and path", async () => {
    expect(await hostsOf("plugin-imap", ticketFor())).toEqual([
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

  it("scopes the hosts to the one Source the ticket names, not every Source of its type", async () => {
    expect(await hostsOf("plugin-imap", ticketFor({ sourceId: "source-2" }))).toEqual(["login.example.com:443", "other.example"]);
  });

  it("answers one plugin container for two Families from each Family's own Sources", async () => {
    expect(await hostsOf("plugin-imap", ticketFor({ familyId: "family-b" }))).toEqual(["login.example.com:443", "mail.family-b.example"]);
    expect(await hostsOf("plugin-imap", ticketFor({ familyId: "family-a", sourceId: "source-2" }))).toEqual(["login.example.com:443", "other.example"]);
  });

  it("serves the hosts a ticket carries for a Source that is not stored, of a known Family", async () => {
    expect(await hostsOf("plugin-imap", ticketFor({ sourceId: "new", hosts: ["new.example:993", "*"] }))).toEqual(["login.example.com:443", "new.example:993"]);
    expect((await get("plugin-imap", `Bearer ${ticketFor({ familyId: "family-c", hosts: ["new.example"] })}`)).status).toBe(403);
  });

  it("serves only the declared hosts for a call of no Source, such as for the Catalogue entries, of a known Family", async () => {
    expect(await hostsOf("plugin-imap", ticketFor({ sourceId: null }))).toEqual(["login.example.com:443"]);
    expect((await get("plugin-imap", `Bearer ${ticketFor({ familyId: "family-c", sourceId: null })}`)).status).toBe(403);
  });

  it("rejects a request without a ticket", async () => {
    expect((await get("plugin-imap")).status).toBe(401);
    expect((await get("plugin-imap", "Basic abc")).status).toBe(401);
  });

  it.each([
    ["an expired ticket", "plugin-imap", () => ticketFor({ expiresAt: now })],
    ["a tampered ticket", "plugin-imap", () => `${ticketFor().split(".")[0] ?? ""}.${ticketFor({ sourceId: "source-2" }).split(".")[1] ?? ""}`],
    ["a ticket signed with another key", "plugin-imap", () => mintTicket("another-ticket-key-of-at-least-32-chars", claims())],
    ["a ticket of an unknown Family", "plugin-imap", () => ticketFor({ familyId: "family-c" })],
    ["a ticket of a Source that is not stored", "plugin-imap", () => ticketFor({ sourceId: "source-9" })],
    ["a ticket naming another Source Type than its Source's", "plugin-ics", () => ticketFor({ sourceTypeId: "ics" })],
    ["a ticket for another container", "plugin-ics", () => ticketFor()],
    ["a ticket for a companion", "plugin-imap-helper", () => ticketFor()],
  ])("refuses %s", async (_, service, ticket) => {
    expect((await get(service, `Bearer ${ticket()}`)).status).toBe(403);
  });
});

describe("parseEntry", () => {
  it.each([
    ["api.example.com:443", { name: "api.example.com", wildcard: false, port: 443 }],
    ["IMAP.gmx.net", { name: "imap.gmx.net", wildcard: false, port: null }],
    ["*.example.org:443", { name: "example.org", wildcard: true, port: 443 }],
    ["*", null],
    ["*.", null],
    ["https://example.org", null],
    ["example.org/path", null],
    ["example.org:0", null],
    ["example.org:65536", null],
    ["-bad.example", null],
    ["", null],
  ])("%s", (text, entry) => {
    expect(parseEntry(text)).toEqual(entry);
  });
});

describe("allows", () => {
  const entries = ["api.example.com:443", "*.example.org:443", "imap.gmx.net"].flatMap((text) => parseEntry(text) ?? []);

  it.each([
    ["api.example.com", 443, true],
    ["API.Example.com", 443, true],
    ["api.example.com", 80, false],
    ["evil-api.example.com", 443, false],
    ["a.example.org", 443, true],
    ["a.b.example.org", 443, true],
    ["example.org", 443, false],
    ["badexample.org", 443, false],
    ["imap.gmx.net", 993, true],
    ["imap.gmx.net", 143, true],
    ["smtp.gmx.net", 993, false],
  ])("%s:%i → %s", (host, port, allowed) => {
    expect(allows(entries, { host, port })).toBe(allowed);
  });

  it("allows nothing with an empty list", () => {
    expect(allows([], { host: "api.example.com", port: 443 })).toBe(false);
  });
});
