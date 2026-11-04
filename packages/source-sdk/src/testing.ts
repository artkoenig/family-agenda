import { describe, expect, it } from "vitest";
import {
  parseManifest,
  problemsWith,
  problemsWithOrigin,
  type Catalogue,
  type ConfigField,
  type IngestContext,
  type PluginText,
  type RunContext,
  type SetupStep,
  type SourceAttributes,
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
  texts.push(...fieldTexts(plugin.configuration.fields));
  texts.push(...stepTexts(plugin.setupSteps));
  if (plugin.catalogue) texts.push(...(await catalogueTexts(plugin.catalogue)));
  if (packageJson !== undefined) texts.push(...manifestTexts(packageJson));
  return texts;
}

function fieldTexts(fields: ConfigField[]): [string, PluginText][] {
  const texts: [string, PluginText][] = [];
  for (const field of fields) {
    texts.push([`configuration field ${field.key}'s label`, field.label]);
    if (field.description !== undefined) texts.push([`configuration field ${field.key}'s description`, field.description]);
  }
  return texts;
}

function stepTexts(steps: SetupStep[]): [string, PluginText][] {
  const texts: [string, PluginText][] = [];
  for (const step of steps) {
    texts.push([`setup step ${step.id}'s title`, step.title], [`setup step ${step.id}'s description`, step.description]);
  }
  return texts;
}

async function catalogueTexts(catalogue: Catalogue): Promise<[string, PluginText][]> {
  const texts: [string, PluginText][] = [["the catalogue's title", catalogue.title]];
  for (const entry of await catalogue.entries()) {
    texts.push([`catalogue entry ${entry.id}'s name`, entry.displayName], [`catalogue entry ${entry.id}'s description`, entry.description]);
    if (entry.riskNotice !== undefined) texts.push([`catalogue entry ${entry.id}'s risk notice`, entry.riskNotice]);
  }
  return texts;
}

function manifestTexts(packageJson: unknown): [string, PluginText][] {
  const result = parseManifest(packageJson);
  if (!result.ok) throw new Error(`the manifest is invalid: ${result.problem}`);
  const { manifest } = result;
  const texts: [string, PluginText][] = [["the manifest's displayName", manifest.identity.displayName], ["the manifest's description", manifest.description]];
  if (manifest.riskNotice !== undefined) texts.push(["the manifest's riskNotice", manifest.riskNotice]);
  return texts;
}

/** A `SourceAttributes` that remembers what a plugin declared, as the Instance would for a Source. */
export function recordingAttributes(): SourceAttributes & { active(): string[] } {
  const names = new Map<string, string>();
  const archived = new Set<string>();
  return {
    declare(attributes) {
      for (const { externalId, name } of attributes) {
        names.set(externalId, name);
        archived.delete(externalId);
      }
      return Promise.resolve();
    },
    archive(externalId) {
      if (names.has(externalId)) archived.add(externalId);
      return Promise.resolve();
    },
    /** The ids declared and not archived since. */
    active: () => [...names.keys()].filter((id) => !archived.has(id)),
  };
}

/**
 * Runs a polling plugin twice, the second time with the sync cursor of the first, and returns the
 * Source Attribute ids its Origins named without being declared (and not archived) by then, in
 * the order they came. Empty for a plugin that declares before it emits.
 */
export async function undeclaredAttributes(plugin: SourcePlugin, config: RunContext["config"], now = new Date()): Promise<string[]> {
  if (plugin.ingestion.mode !== "polling") return [];
  const attributes = recordingAttributes();
  const undeclared: string[] = [];
  let syncCursor: string | null = null;
  for (let run = 0; run < 2; run++) {
    const context: IngestContext = { config, syncCursor, now, timeZone: "Europe/Berlin", attributes };
    const result = await plugin.ingestion.poll(context);
    const known = new Set(attributes.active());
    for (const origin of result.origins) {
      for (const id of origin.attributes) if (!known.has(id) && !undeclared.includes(id)) undeclared.push(id);
    }
    syncCursor = result.syncCursor;
  }
  return undeclared;
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

    it("declares setup steps once each", () => {
      const steps = createPlugin().setupSteps.map((step) => step.id);
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
        const attributes = recordingAttributes();
        const context = { config, now, timeZone: "Europe/Berlin", attributes };
        const result = await plugin.ingestion.poll({ ...context, syncCursor: null });
        for (const origin of result.origins) expect(problemsWithOrigin(origin)).toEqual([]);
        expect(result.syncCursor === null || typeof result.syncCursor === "string").toBe(true);
        const again = await plugin.ingestion.poll({ ...context, syncCursor: result.syncCursor });
        const messages = again.origins.filter((origin) => origin.content.kind === "raw-message");
        expect(messages, "a second run with the sync cursor of the first emits no message again").toEqual([]);
      });

      it("declares a Source Attribute before an Origin names it", async () => {
        expect(await undeclaredAttributes(createPlugin(), config, now), "Source Attribute ids named without being declared").toEqual([]);
      });
    }
  });
}
