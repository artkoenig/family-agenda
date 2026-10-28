import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sdkVersion,
  SourceError,
  type Configuration,
  type Origin,
  type PluginText,
  type RunContext,
  type SetupStep,
  type SourcePlugin,
} from "@family-agenda/source-sdk";

/** Source Type ids whose test plugin code has been loaded, in the order they were. */
export const loadedTestPlugins: string[] = [];

const pending = new Map<string, { origins: Origin[]; failure?: SourceError }>();
const runs = new Map<string, RunContext[]>();
const knownValues = new Map<string, { value: string; label: string }[] | "fail">();

/** Controls what the test plugin of a Source Type does on its next run. */
export const testPluginControls = {
  emit(sourceTypeId: string, origins: Origin[]): void {
    pending.set(sourceTypeId, { origins });
  },
  failNext(sourceTypeId: string, kind: "definite" | "temporary"): void {
    pending.set(sourceTypeId, { origins: [], failure: new SourceError(`${sourceTypeId} failed`, kind) });
  },
  /** What the plugin's `sender` attribute says it knows of from now on, or that asking it fails. */
  knowValues(sourceTypeId: string, values: { value: string; label: string }[] | "fail"): void {
    knownValues.set(sourceTypeId, values);
  },
  /** What the plugin of a Source Type was run with so far, oldest first. */
  runs(sourceTypeId: string): RunContext[] {
    return runs.get(sourceTypeId) ?? [];
  },
};

export type TestPluginOptions = {
  sourceTypeId: string;
  configuration?: Configuration;
  /** Whether its Sources count as Silent without new Origins; by default they do. */
  silentApplies?: boolean;
  setupSteps?: SetupStep[];
};

/** A polling plugin that emits the Origins it was given and fails on demand. */
export function testSourcePlugin(options: TestPluginOptions): SourcePlugin {
  const { sourceTypeId } = options;
  loadedTestPlugins.push(sourceTypeId);
  return {
    identity: { sourceTypeId, displayName: sourceTypeId, version: "1.0.0", sdkVersion },
    configuration: options.configuration ?? {
      version: 1,
      fields: [
        { key: "url", label: "URL", secret: false, required: true },
        { key: "password", label: "Password", secret: true, required: false },
      ],
    },
    setupSteps: options.setupSteps ?? [],
    ingestion: {
      mode: "polling",
      suggestedIntervalSeconds: 600,
      poll: (context) => {
        const { state } = context;
        runs.set(sourceTypeId, [...(runs.get(sourceTypeId) ?? []), context]);
        const next = pending.get(sourceTypeId) ?? { origins: [] };
        pending.delete(sourceTypeId);
        if (next.failure) return Promise.reject(next.failure);
        return Promise.resolve({ origins: next.origins, state: String(Number(state ?? 0) + 1) });
      },
    },
    originAttributes: [
      {
        key: "sender",
        label: "Sender",
        knownValues: () => {
          const values = knownValues.get(sourceTypeId) ?? [];
          return values === "fail" ? Promise.reject(new Error("unreachable")) : Promise.resolve(values);
        },
      },
    ],
    health: { silentApplies: options.silentApplies ?? true },
  };
}

export type TestPluginPackage = {
  sourceTypeId: string;
  /** The package's directory name; by default the Source Type id. */
  directory?: string;
  displayName?: PluginText;
  version?: string;
  sdkVersion?: string;
  description?: PluginText;
  needsLlm?: boolean;
  riskNotice?: PluginText;
  /** Source code of a configuration (an object literal) the plugin declares. */
  configuration?: string;
  silentApplies?: boolean;
  setupSteps?: SetupStep[];
};

const pluginModule = fileURLToPath(new URL("./test-source-plugin.ts", import.meta.url));

/** Writes a package with a test plugin into a directory the SourceRegistry looks in. */
export async function writeTestPluginPackage(directory: string, plugin: TestPluginPackage): Promise<void> {
  const packageDirectory = join(directory, plugin.directory ?? plugin.sourceTypeId);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({
      name: `family-agenda-source-${plugin.sourceTypeId}`,
      version: plugin.version ?? "1.0.0",
      type: "module",
      familyAgenda: {
        sourcePlugin: {
          entry: "./index.ts",
          sourceTypeId: plugin.sourceTypeId,
          displayName: plugin.displayName ?? plugin.sourceTypeId,
          sdkVersion: plugin.sdkVersion ?? sdkVersion,
          description: plugin.description ?? `Reads ${plugin.sourceTypeId}.`,
          needsLlm: plugin.needsLlm ?? false,
          ...(plugin.riskNotice ? { riskNotice: plugin.riskNotice } : {}),
        },
      },
    }),
  );
  const configuration = plugin.configuration ? `, configuration: ${plugin.configuration}` : "";
  const silentApplies = plugin.silentApplies !== undefined ? `, silentApplies: ${plugin.silentApplies}` : "";
  const setupSteps = plugin.setupSteps ? `, setupSteps: ${JSON.stringify(plugin.setupSteps)}` : "";
  await writeFile(
    join(packageDirectory, "index.ts"),
    `import { testSourcePlugin } from ${JSON.stringify(pluginModule)};\n` +
      `export default testSourcePlugin({ sourceTypeId: ${JSON.stringify(plugin.sourceTypeId)}${configuration}${silentApplies}${setupSteps} });\n`,
  );
}
