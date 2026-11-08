import { describe, expect, it } from "vitest";
import { pluginHostFrom } from "../src/self-hosted";

describe("the Plugin Host setting", () => {
  it("is needed with an address and a token", () => {
    expect(() => pluginHostFrom({})).toThrow("PLUGIN_HOST_URL is not set");
    expect(() => pluginHostFrom({ PLUGIN_HOST_URL: "http://plugin-host:4100" })).toThrow("PLUGIN_HOST_TOKEN is not set");
    expect(() => pluginHostFrom({ PLUGIN_HOST_TOKEN: "t" })).toThrow("PLUGIN_HOST_URL is not set");
  });

  it("is read from both", () => {
    expect(pluginHostFrom({ PLUGIN_HOST_URL: "http://h", PLUGIN_HOST_TOKEN: "t" })).toEqual({ url: "http://h", token: "t" });
  });
});
