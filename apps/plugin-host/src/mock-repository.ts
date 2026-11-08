import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { parseManifest, type SourcePluginManifest } from "@family-agenda/source-sdk";
import type { PluginRepository, RepositoryEntry } from "./repository";

/**
 * Stands in for the Plugin Repository until there is one: publishes the plugins of packages in
 * this workspace, each bundled with everything it imports, the SDK included.
 */
export class MockPluginRepository implements PluginRepository {
  private constructor(private readonly published: Map<string, { manifest: SourcePluginManifest; bundle: string }>) {}

  static async fromPackages(packageDirectories: string[]): Promise<MockPluginRepository> {
    const published = new Map<string, { manifest: SourcePluginManifest; bundle: string }>();
    for (const directory of packageDirectories) {
      const result = parseManifest(JSON.parse(await readFile(join(directory, "package.json"), "utf8")));
      if (!result.ok) throw new Error(`${directory} holds no valid Source plugin manifest.`);
      published.set(result.manifest.identity.sourceTypeId, { manifest: result.manifest, bundle: await bundleOf(join(directory, result.manifest.entry)) });
    }
    return new MockPluginRepository(published);
  }

  index(): Promise<RepositoryEntry[]> {
    return Promise.resolve([...this.published.values()].map(({ manifest, bundle }) => ({ manifest, sha256: createHash("sha256").update(bundle).digest("hex") })));
  }

  bundle(sourceTypeId: string): Promise<string> {
    const entry = this.published.get(sourceTypeId);
    return entry ? Promise.resolve(entry.bundle) : Promise.reject(new Error(`The repository publishes no plugin "${sourceTypeId}".`));
  }
}

async function bundleOf(entry: string): Promise<string> {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  const [output] = result.outputFiles;
  if (!output) throw new Error(`Bundling ${entry} gave no output.`);
  return output.text;
}
