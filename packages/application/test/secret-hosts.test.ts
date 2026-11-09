import { describe, expect, it } from "vitest";
import { hostOf, secretHostsOf } from "../src/secret-hosts";

const fields = [
  { key: "url", secret: true, host: true },
  { key: "password", secret: true },
  { key: "server", secret: false, host: true },
];

describe("the host of an address", () => {
  it.each([
    ["https://calendar.google.com/calendar/ical/x/private-token/basic.ics", "calendar.google.com"],
    ["webcal://Example.ORG:8443/cal.ics?key=1", "example.org:8443"],
    ["  https://user:token@cal.example/feed  ", "cal.example"],
    ["cal.example#x", "cal.example"],
    ["cal.example?token=a@b", "cal.example"],
    ["", ""],
  ])("of %j is %j", (value, host) => {
    expect(hostOf(value)).toBe(host);
  });
});

describe("the hosts of a Source's secret host fields", () => {
  it("are those of the values entered, for secret host fields only", () => {
    const entered = { url: "https://cal.example/t", password: "https://not.a.host/", server: "ignored.example" };

    expect(secretHostsOf(fields, entered, {})).toEqual({ url: "cal.example" });
  });

  it("keep the previous host for a value left empty or not entered, and replace it for a new one", () => {
    expect(secretHostsOf(fields, { url: "  " }, { url: "old.example" })).toEqual({ url: "old.example" });
    expect(secretHostsOf(fields, {}, { url: "old.example" })).toEqual({ url: "old.example" });
    expect(secretHostsOf(fields, { url: "https://new.example/x" }, { url: "old.example" })).toEqual({ url: "new.example" });
  });

  it("leave out a field whose value has no host", () => {
    expect(secretHostsOf(fields, { url: "https:///path" }, {})).toEqual({});
  });
});
