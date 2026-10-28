import { describe, expect, it } from "vitest";
import {
  parseManifest,
  problemsWith,
  problemsWithOrigin,
  type PluginText,
  type RunContext,
  type SourcePlugin,
} from "./index";

export type ContractOptions = {
  /** A configuration to run the plugin with once; without it, the plugin is not run. */
  config?: RunContext["config"];
  /** The time of that run; by default the current time. */
  now?: Date;
  /** Languages besides English that every text of the plugin is given in, such as `["de"]`. */
  languages?: string[];
  /** The plugin's `package.json`, whose manifest's texts are checked for `languages` too. */
  packageJson?: unknown;
};

/** Every text a plugin shows, by where it comes from. */
async function textsOf(plugin: SourcePlugin, packageJson: unknown): Promise<[string, PluginText][]> {
  const texts: [string, PluginText][] = [["identity.displayName", plugin.identity.displayName]];
  for (const field of plugin.configuration.fields) {
    texts.push([`configuration field ${field.key}'s label`, field.label]);
    if (field.description !== undefined) texts.push([`configuration field ${field.key}'s description`, field.description]);
  }
  for (const step of plugin.setupSteps) {
    texts.push([`setup step ${step.id}'s title`, step.title], [`setup step ${step.id}'s description`, step.description]);
  }
  for (const attribute of plugin.originAttributes) texts.push([`Origin attribute ${attribute.key}'s label`, attribute.label]);
  if (plugin.catalogue) {
    texts.push(["the catalogue's title", plugin.catalogue.title]);
    for (const entry of await plugin.catalogue.entries()) {
      texts.push([`catalogue entry ${entry.id}'s name`, entry.displayName], [`catalogue entry ${entry.id}'s description`, entry.description]);
      if (entry.riskNotice !== undefined) texts.push([`catalogue entry ${entry.id}'s risk notice`, entry.riskNotice]);
    }
  }
  if (packageJson !== undefined) {
    const result = parseManifest(packageJson);
    if (!result.ok) throw new Error(`the manifest is invalid: ${result.problem}`);
    const { manifest } = result;
    texts.push(["the manifest's displayName", manifest.identity.displayName], ["the manifest's description", manifest.description]);
    if (manifest.riskNotice !== undefined) texts.push(["the manifest's riskNotice", manifest.riskNotice]);
  }
  return texts;
}

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

    if (createPlugin().catalogue) {
      it("lists each catalogue entry once", async () => {
        const ids = (await createPlugin().catalogue?.entries())?.map((entry) => entry.id) ?? [];
        expect(new Set(ids).size).toBe(ids.length);
      });
    }

    it("migrates a configuration of every older version to the current one", () => {
      const { configuration } = createPlugin();
      for (let from = 1; from < configuration.version; from++) {
        expect(configuration.migrations?.[from]?.({})).toBeTypeOf("object");
      }
    });

    for (const language of options.languages ?? []) {
      it(`gives every text in ${language} too`, async () => {
        const missing = (await textsOf(createPlugin(), options.packageJson))
          .filter(([, text]) => typeof text === "string" || !text[language]?.trim())
          .map(([where]) => where);
        expect(missing, `texts without ${language}`).toEqual([]);
      });
    }

    const { config, now = new Date() } = options;
    if (config) {
      it("emits valid Origins and state for a Source", async () => {
        const plugin = createPlugin();
        if (plugin.ingestion.mode !== "polling") return;
        const known = new Set(plugin.originAttributes.map((attribute) => attribute.key));
        const result = await plugin.ingestion.poll({ config, state: null, now, timeZone: "Europe/Berlin" });
        for (const origin of result.origins) {
          expect(problemsWithOrigin(origin)).toEqual([]);
          for (const key of Object.keys(origin.attributes)) expect(known).toContain(key);
        }
        expect(result.state === null || typeof result.state === "string").toBe(true);
        const again = await plugin.ingestion.poll({ config, state: result.state, now, timeZone: "Europe/Berlin" });
        expect(again.origins, "a second run with the state of the first emits no Origin again").toEqual([]);
      });
    }
  });
}
