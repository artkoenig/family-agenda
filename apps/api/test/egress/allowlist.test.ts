import type { SourceTypeId } from "@family-agenda/domain";
import { describe, expect, it } from "vitest";
import { allowlistOf, allows, parsePluginEgress, type AllowlistSources } from "../../src/egress/allowlist";
import { createAllowlistApp } from "../../src/egress/allowlist-server";

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

const sources: AllowlistSources = {
  declared: new Map([
    ["plugin-imap", ["login.example.com:443"]],
    ["plugin-imap-helper", ["helper.example.com:443"]],
  ]),
  bindings: [{ sourceTypeId: "imap" as SourceTypeId, url: "http://plugin-imap:8080" }],
  hostsOf: (id) => Promise.resolve(id === "imap" ? ["imap.gmx.net", "login.example.com:443"] : ["unexpected"]),
};

describe("allowlistOf", () => {
  it("adds the hosts of a plugin's Sources to its own container's declared ones", async () => {
    expect(await allowlistOf("plugin-imap", sources)).toEqual(["login.example.com:443", "imap.gmx.net"]);
  });

  it("gives a companion only its declared hosts", async () => {
    expect(await allowlistOf("plugin-imap-helper", sources)).toEqual(["helper.example.com:443"]);
  });

  it("gives an unknown container nothing", async () => {
    expect(await allowlistOf("plugin-other", sources)).toEqual([]);
  });

  it("is served per container", async () => {
    const response = await createAllowlistApp(sources).request("/egress/plugin-imap");
    expect(await response.json()).toEqual({ hosts: ["login.example.com:443", "imap.gmx.net"] });
  });
});

describe("allows", () => {
  const allowlist = ["api.example.com:443", "*.example.org:443", "IMAP.gmx.net"];

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
    expect(allows(allowlist, host, port)).toBe(allowed);
  });

  it("allows nothing with an empty list", () => {
    expect(allows([], "api.example.com", 443)).toBe(false);
  });
});
