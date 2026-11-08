import { describe, expect, it } from "vitest";
import { pluginHostFrom } from "../src/self-hosted";

describe("the Plugin Host setting", () => {
  it("is off without an address or a token", () => {
    expect(pluginHostFrom({})).toBeNull();
    expect(pluginHostFrom({ PLUGIN_HOST_URL: "http://plugin-host:4100" })).toBeNull();
    expect(pluginHostFrom({ PLUGIN_HOST_TOKEN: "t" })).toBeNull();
  });

  it("is on with both", () => {
    expect(pluginHostFrom({ PLUGIN_HOST_URL: "http://h", PLUGIN_HOST_TOKEN: "t" })).toEqual({ url: "http://h", token: "t" });
  });
});
