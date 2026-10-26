/**
 * Run with `node --import tsx` as in production, where Node's own loader resolves a plugin's
 * imports. Discovers the plugins in the directory given, loads the one given, runs its poll and
 * prints what happened as JSON.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { SourceError, type SourcePlugin } from "@family-butler/source-sdk";
import type { SourceTypeId } from "@family-butler/domain";
import { SourceRegistry } from "../../src/source-registry";

const [directory = "", packageName = "", sourceTypeId = ""] = process.argv.slice(2);
const registry = await SourceRegistry.discover([directory]);
const loaded = await registry.load(sourceTypeId as SourceTypeId);
const notLoadable = registry.installed().find((type) => type.id === sourceTypeId)?.notLoadable ?? null;
let error: unknown = null;
if (loaded.ok) {
  // The module the registry loaded, from Node's cache.
  const entry = pathToFileURL(join(directory, packageName, "index.ts")).href;
  const plugin = ((await import(entry)) as { default: SourcePlugin }).default;
  if (plugin.ingestion.mode === "polling") {
    error = await plugin.ingestion.poll({ config: { plain: {}, secrets: {} }, state: null }).catch((e: unknown) => e);
  }
}
console.log(JSON.stringify({ loaded: loaded.ok, notLoadable, isCoreSourceError: error instanceof SourceError }));
