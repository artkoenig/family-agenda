import { describe, expect, it } from "vitest";
import { pluginRunsOn } from "../src/sdk";

describe("which plugins run on which SDK", () => {
  it.each([
    ["1.0.0", "1.0.0", true],
    ["1.0.0", "1.4.0", true],
    ["1.4.0", "1.0.0", false],
    ["1.0.0", "2.0.0", false],
    ["2.0.0", "1.9.0", false],
    ["0.2.0", "0.2.5", true],
    ["0.2.0", "0.3.0", false],
  ])("a plugin built for %s on SDK %s: %s", (builtFor, running, runs) => {
    expect(pluginRunsOn(builtFor, running)).toBe(runs);
  });
});
