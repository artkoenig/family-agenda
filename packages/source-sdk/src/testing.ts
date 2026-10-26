import { describe, expect, it } from "vitest";
import { problemsWith, problemsWithOrigin, type RunContext, type SourcePlugin } from "./index";

export type ContractOptions = {
  /** A configuration to run the plugin with once; without it, the plugin is not run. */
  config?: RunContext["config"];
};

/**
 * The contract tests every Source plugin passes, first-party and third-party alike.
 * Call it from the plugin's own test file with a factory for the plugin under test.
 */
export function describeSourcePluginContract(
  createPlugin: () => SourcePlugin,
  options: ContractOptions = {},
): void {
  describe(`Source plugin contract`, () => {
    it("is loadable by this SDK", () => {
      expect(problemsWith(createPlugin())).toEqual([]);
    });

    it("declares Origin attributes and setup steps once each", () => {
      const plugin = createPlugin();
      const attributes = plugin.originAttributes.map((attribute) => attribute.key);
      const steps = plugin.setupSteps.map((step) => step.id);
      expect(new Set(attributes).size).toBe(attributes.length);
      expect(new Set(steps).size).toBe(steps.length);
    });

    it("migrates a configuration of every older version to the current one", () => {
      const { configuration } = createPlugin();
      for (let from = 1; from < configuration.version; from++) {
        expect(configuration.migrations?.[from]?.({})).toBeTypeOf("object");
      }
    });

    const { config } = options;
    if (config) {
      it("emits valid Origins and state for a Source", async () => {
        const plugin = createPlugin();
        if (plugin.ingestion.mode !== "polling") return;
        const known = new Set(plugin.originAttributes.map((attribute) => attribute.key));
        const result = await plugin.ingestion.poll({ config, state: null });
        for (const origin of result.origins) {
          expect(problemsWithOrigin(origin)).toEqual([]);
          for (const key of Object.keys(origin.attributes)) expect(known).toContain(key);
        }
        expect(result.state === null || typeof result.state === "string").toBe(true);
      });
    }
  });
}
