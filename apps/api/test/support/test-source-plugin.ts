import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  sdkVersion,
  SourceError,
  type CatalogueEntry,
  type Configuration,
  type IngestContext,
  type Origin,
  type PluginText,
  type SourceAttributeDeclaration,
  type RunContext,
  type SetupProgress,
  type SetupStep,
  type SourcePlugin,
} from "@family-agenda/source-sdk";

/** Source Type ids whose test plugin code has been loaded, in the order they were. */
export const loadedTestPlugins: string[] = [];

const pending = new Map<string, { origins: Origin[]; failure?: SourceError; withdrawn?: string[] }>();
const runs = new Map<string, RunContext[]>();
const declaring = new Map<string, SourceAttributeDeclaration[]>();
const archiving = new Map<string, string[]>();
const undeclared = new Set<string>();
const knownValues = new Map<string, { value: string; label: string }[]>();
const catalogueEntries = new Map<string, CatalogueEntry[]>();
const setupProgress = new Map<string, SetupProgress>();
const addingFails = new Set<string>();
const removed = new Map<string, RunContext[]>();
const reconciled = new Map<string, { enabled: boolean; entries: string[] }[]>();
const stopped = new Map<string, number>();
const reconcilingFails = new Set<string>();
let accounts = 0;

/** Controls what the test plugin of a Source Type does on its next run. */
export const testPluginControls = {
  /**
   * On its next run, the plugin emits these Origins, having declared every Source Attribute they
   * name (as its own name) unless `declaring` is false, as a plugin that breaks the contract would.
   */
  emit(sourceTypeId: string, origins: Origin[], options: { declaring?: boolean } = {}): void {
    pending.set(sourceTypeId, { origins });
    if (options.declaring === false) undeclared.add(sourceTypeId);
  },
  /** On its next run, the plugin also declares these Source Attributes, naming them as given. */
  declare(sourceTypeId: string, attributes: SourceAttributeDeclaration[]): void {
    declaring.set(sourceTypeId, [...(declaring.get(sourceTypeId) ?? []), ...attributes]);
  },
  /** On its next run, after declaring, the plugin archives these Source Attributes. */
  archive(sourceTypeId: string, externalIds: string[]): void {
    archiving.set(sourceTypeId, [...(archiving.get(sourceTypeId) ?? []), ...externalIds]);
  },
  /** On its next run, the plugin says these Origins were deleted, along with any it emits. */
  withdraw(sourceTypeId: string, externalIds: string[], origins: Origin[] = []): void {
    pending.set(sourceTypeId, { origins, withdrawn: externalIds });
  },
  /** The entries the plugin's catalogue lists from now on, if it declares one. */
  catalogue(sourceTypeId: string, entries: CatalogueEntry[]): void {
    catalogueEntries.set(sourceTypeId, entries);
  },
  /** What the plugin's live setup steps show from now on. */
  setupShows(sourceTypeId: string, progress: SetupProgress): void {
    setupProgress.set(sourceTypeId, progress);
  },
  /** Makes preparing the next Source being added fail. */
  failAdding(sourceTypeId: string): void {
    addingFails.add(sourceTypeId);
  },
  /** What the plugin was told of removed Sources, oldest first. */
  removed(sourceTypeId: string): RunContext[] {
    return removed.get(sourceTypeId) ?? [];
  },
  /** What the plugin's services were reconciled with so far, oldest first. */
  reconciled(sourceTypeId: string): { enabled: boolean; entries: string[] }[] {
    return reconciled.get(sourceTypeId) ?? [];
  },
  /** How often the plugin's services were stopped. */
  stopped(sourceTypeId: string): number {
    return stopped.get(sourceTypeId) ?? 0;
  },
  /** Makes reconciling the plugin's services fail next time. */
  failReconciling(sourceTypeId: string): void {
    reconcilingFails.add(sourceTypeId);
  },
  failNext(sourceTypeId: string, kind: "definite" | "temporary"): void {
    pending.set(sourceTypeId, { origins: [], failure: new SourceError(`${sourceTypeId} failed`, kind) });
  },
  /** The values the plugin's choice fields offer from now on, such as a Messenger's chats. */
  knowValues(sourceTypeId: string, values: { value: string; label: string }[]): void {
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
  /** A catalogue whose entries `testPluginControls.catalogue` sets; by default it has none. */
  catalogue?: { configKey: string };
  /** Setup steps driven live through `testPluginControls.setupShows`. */
  liveSteps?: string[];
  /** Services whose reconciling `testPluginControls.reconciled` records. */
  services?: boolean;
};

/**
 * A polling plugin that emits the Origins it was given and fails on demand. Fields set by the
 * plugin get `account-<n>` when a Source is added, and a choice field offers the values its
 * `sender` attribute knows.
 */
export function testSourcePlugin(options: TestPluginOptions): SourcePlugin {
  const plugin = basicTestSourcePlugin(options);
  const { sourceTypeId } = options;
  const live = (options.liveSteps ?? []).map((id) => ({
    id,
    title: id,
    description: `Go through ${id}.`,
    progress: () => Promise.resolve(setupProgress.get(sourceTypeId) ?? ({ status: "waiting" } as const)),
  }));
  const fields = plugin.configuration.fields.map((field) =>
    field.choices ? { ...field, choices: () => Promise.resolve(knownValueList(sourceTypeId)) } : field,
  );
  return {
    ...plugin,
    configuration: { ...plugin.configuration, fields },
    setupSteps: [...plugin.setupSteps, ...live],
    ...(options.catalogue
      ? {
          catalogue: {
            title: "Networks",
            configKey: options.catalogue.configKey,
            entries: () => Promise.resolve(catalogueEntries.get(sourceTypeId) ?? []),
          },
        }
      : {}),
    ...(options.services
      ? {
          services: {
            reconcile: (enabled: { enabled: boolean; entries: string[] }) => {
              reconciled.set(sourceTypeId, [...(reconciled.get(sourceTypeId) ?? []), enabled]);
              if (reconcilingFails.delete(sourceTypeId)) return Promise.reject(new Error("the homeserver did not start"));
              return Promise.resolve();
            },
            stop: () => {
              stopped.set(sourceTypeId, (stopped.get(sourceTypeId) ?? 0) + 1);
              return Promise.resolve();
            },
          },
        }
      : {}),
    sourceAdded: () => {
      if (addingFails.delete(sourceTypeId)) return Promise.reject(SourceError.temporary("the homeserver is unreachable"));
      accounts += 1;
      const plain: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      for (const field of fields.filter((candidate) => candidate.setByPlugin)) {
        (field.secret ? secrets : plain)[field.key] = `${field.key}-${accounts}`;
      }
      return Promise.resolve({ plain, secrets });
    },
    sourceRemoved: (context) => {
      removed.set(sourceTypeId, [...(removed.get(sourceTypeId) ?? []), context]);
      return Promise.resolve();
    },
  };
}

function knownValueList(sourceTypeId: string): { value: string; label: string }[] {
  return knownValues.get(sourceTypeId) ?? [];
}

/** A polling plugin that emits the Origins it was given and fails on demand. */
function basicTestSourcePlugin(options: TestPluginOptions): SourcePlugin {
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
      poll: async (context) => {
        const { syncCursor } = context;
        runs.set(sourceTypeId, [...(runs.get(sourceTypeId) ?? []), context]);
        const next = pending.get(sourceTypeId) ?? { origins: [] };
        pending.delete(sourceTypeId);
        if (next.failure) throw next.failure;
        await reportAttributes(sourceTypeId, context, next.origins);
        return {
          origins: next.origins,
          syncCursor: String(Number(syncCursor ?? 0) + 1),
          ...(next.withdrawn ? { withdrawn: next.withdrawn } : {}),
        };
      },
    },
    health: { silentApplies: options.silentApplies ?? true },
  };
}

/** Declares the Source Attributes the Origins name and those asked for, then archives those asked for. */
async function reportAttributes(sourceTypeId: string, context: IngestContext, origins: Origin[]): Promise<void> {
  const named = new Map<string, string>();
  if (!undeclared.delete(sourceTypeId)) for (const id of origins.flatMap((origin) => origin.attributes)) named.set(id, id);
  for (const { externalId, name } of declaring.get(sourceTypeId) ?? []) named.set(externalId, name);
  declaring.delete(sourceTypeId);
  if (named.size > 0) await context.attributes.declare([...named].map(([externalId, name]) => ({ externalId, name })));
  for (const externalId of archiving.get(sourceTypeId) ?? []) await context.attributes.archive(externalId);
  archiving.delete(sourceTypeId);
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
  catalogue?: { configKey: string };
  liveSteps?: string[];
  services?: boolean;
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
  const catalogue = plugin.catalogue ? `, catalogue: ${JSON.stringify(plugin.catalogue)}` : "";
  const liveSteps = plugin.liveSteps ? `, liveSteps: ${JSON.stringify(plugin.liveSteps)}` : "";
  const services = plugin.services ? ", services: true" : "";
  await writeFile(
    join(packageDirectory, "index.ts"),
    `import { testSourcePlugin } from ${JSON.stringify(pluginModule)};\n` +
      `export default testSourcePlugin({ sourceTypeId: ${JSON.stringify(plugin.sourceTypeId)}${configuration}${silentApplies}${setupSteps}${catalogue}${liveSteps}${services} });\n`,
  );
}
