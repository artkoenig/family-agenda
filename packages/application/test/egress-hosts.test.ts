import { describe, expect, it } from "vitest";
import { hostsOfSource } from "../src/egress-hosts";
import type { ConfigFieldSpec } from "../src/ports";

function field(key: string, flags: Partial<ConfigFieldSpec> = {}): ConfigFieldSpec {
  return { key, label: { en: key }, secret: false, required: false, description: null, setByPlugin: false, choice: false, host: false, ...flags };
}

const fields = [field("host", { host: true }), field("relay", { host: true }), field("token", { host: true, secret: true }), field("username")];

describe("hostsOfSource", () => {
  it("lists the values of its plain host fields, trimmed, once each", () => {
    expect(hostsOfSource(fields, { plain: { host: " imap.gmx.net ", relay: "imap.gmx.net", token: "secret.example", username: "user.example" }, secretHosts: {} })).toEqual([
      "imap.gmx.net",
    ]);
    expect(hostsOfSource(fields, { plain: { host: "other.example", relay: "relay.example:25" }, secretHosts: {} })).toEqual(["other.example", "relay.example:25"]);
  });

  it("skips empty and non-text values", () => {
    expect(hostsOfSource(fields, { plain: { host: 993, relay: "   " }, secretHosts: {} })).toEqual([]);
  });

  it("lists the hosts kept in the clear of its secret host fields, not the plain values under their keys", () => {
    expect(hostsOfSource(fields, { plain: { token: "plain.example" }, secretHosts: { token: "calendar.google.com", username: "user.example" } })).toEqual(["calendar.google.com"]);
  });

  it("lists none without host fields, such as for a Source whose Source Type cannot be loaded", () => {
    expect(hostsOfSource([], { plain: { host: "imap.gmx.net" }, secretHosts: { token: "cal.example" } })).toEqual([]);
  });
});
