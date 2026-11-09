import { describe, expect, it } from "vitest";
import { contractChecks, pluginClient, type ContractOptions, type PluginTarget } from "./testing";

/**
 * The contract tests as a vitest suite, called from the plugin's own test file. `target` is asked
 * for the plugin in each test, so that a server started in `beforeAll` can be tested by its URL.
 */
export function describePluginContract(target: () => PluginTarget, options: ContractOptions = {}): void {
  describe("plugin contract", () => {
    for (const check of contractChecks(options)) {
      it(check.name, async () => {
        expect(await check.problems(pluginClient(target()))).toEqual([]);
      });
    }
  });
}
