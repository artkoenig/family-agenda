import { createHash } from "node:crypto";
import type { AvailablePlugin } from "@family-agenda/plugin-protocol";
import type { SourcePluginManifest } from "@family-agenda/source-sdk";
import type { PluginManager } from "./manager";

/** One plugin the Plugin Repository publishes: its manifest and the SHA-256 of its bundle, in hex. */
export type RepositoryEntry = { manifest: SourcePluginManifest; sha256: string };

/** Where the Plugin Host gets plugins from: an index of what is published, and each bundle. */
export interface PluginRepository {
  index(): Promise<RepositoryEntry[]>;
  bundle(sourceTypeId: string): Promise<string>;
}

/**
 * Installs every plugin the repository publishes whose bundle matches its hash. A plugin that
 * cannot be fetched, does not match or does not start is left out, with the reason.
 */
export async function installFromRepository(manager: PluginManager, repository: PluginRepository): Promise<{ available: AvailablePlugin[]; failures: string[] }> {
  const available: AvailablePlugin[] = [];
  const failures: string[] = [];
  for (const { manifest, sha256 } of await repository.index()) {
    const id = manifest.identity.sourceTypeId;
    try {
      const bundle = await repository.bundle(id);
      if (createHash("sha256").update(bundle).digest("hex") !== sha256) throw new Error("its bundle does not match the hash the repository publishes");
      const installed = await manager.install(id, bundle);
      if (!installed.ok) throw new Error(installed.failure.message);
      available.push({ manifest, description: installed.description });
    } catch (error) {
      failures.push(`Plugin "${id}" was not installed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { available, failures };
}
