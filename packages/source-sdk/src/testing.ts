import { describe, expect, it } from "vitest";
import { problemsWith, type SourcePlugin } from "./index";

/**
 * The contract tests every Source plugin passes, first-party and third-party alike.
 * Call it from the plugin's own test file with a factory for the plugin under test.
 */
export function describeSourcePluginContract(createPlugin: () => SourcePlugin): void {
  describe(`Source plugin contract`, () => {
    it("is loadable by this SDK", () => {
      expect(problemsWith(createPlugin())).toEqual([]);
    });
  });
}
