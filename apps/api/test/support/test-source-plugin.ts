import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, encode } from "@family-agenda/plugin-protocol";
import {
  sdkVersion,
  SourceError,
  type CatalogueEntry,
  type IngestResult,
  type Origin,
  type PluginText,
  type SourceAttributeDeclaration,
  type RunContext,
  type SetupProgress,
  type SetupStep,
  type SourcePlugin,
} from "@family-agenda/source-sdk";
import { testPluginWith, type Ask, type Questions, type TestPluginOptions } from "./test-plugin-shape";

export type { TestPluginOptions } from "./test-plugin-shape";

const pending = new Map<string, { origins: Origin[]; failure?: SourceError; withdrawn?: string[] }>();
const runs = new Map<string, RunContext[]>();
const declaring = new Map<string, SourceAttributeDeclaration[]>();
const archiving = new Map<string, string[]>();
const undeclared = new Set<string>();
const knownValues = new Map<string, { value: string; label: string }[]>();
const choicesAsked = new Map<string, number>();
const catalogueEntries = new Map<string, CatalogueEntry[]>();
const setupProgress = new Map<string, SetupProgress>();
const addingFails = new Set<string>();
const removed = new Map<string, RunContext[]>();
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
  failNext(sourceTypeId: string, kind: "definite" | "temporary"): void {
    pending.set(sourceTypeId, { origins: [], failure: new SourceError(`${sourceTypeId} failed`, kind) });
  },
  /** The values the plugin's choice fields offer from now on, such as a Messenger's chats. */
  knowValues(sourceTypeId: string, values: { value: string; label: string }[]): void {
    knownValues.set(sourceTypeId, values);
  },
  /** How often the plugin's choice fields were asked for their values. */
  choicesAsked(sourceTypeId: string): number {
    return choicesAsked.get(sourceTypeId) ?? 0;
  },
  /** What the plugin of a Source Type was run with so far, oldest first. */
  runs(sourceTypeId: string): RunContext[] {
    return runs.get(sourceTypeId) ?? [];
  },
};

/** The test plugin, run in process: it asks the test's state directly. */
export function testSourcePlugin(options: TestPluginOptions): SourcePlugin {
  return testPluginWith(options, answer);
}

/** Answers what a test plugin asks, from the state `testPluginControls` sets. */
const answer: Ask = (question, sourceTypeId, args) => Promise.resolve(answers[question](sourceTypeId, args as never) as never);

const answers: { [Q in keyof Questions]: (sourceTypeId: string, args: Questions[Q]["args"]) => Questions[Q]["answer"] } = {
  poll: (sourceTypeId, context) => {
    runs.set(sourceTypeId, [...(runs.get(sourceTypeId) ?? []), context]);
    const next = pending.get(sourceTypeId) ?? { origins: [] };
    pending.delete(sourceTypeId);
    if (next.failure) return { sourceError: next.failure.kind, message: next.failure.message };
    return {
      ...reportedAttributes(sourceTypeId, next.origins),
      origins: next.origins,
      syncCursor: String(Number(context.syncCursor ?? 0) + 1),
      ...(next.withdrawn ? { withdrawn: next.withdrawn } : {}),
    };
  },
  choices: (sourceTypeId) => {
    choicesAsked.set(sourceTypeId, (choicesAsked.get(sourceTypeId) ?? 0) + 1);
    return knownValues.get(sourceTypeId) ?? [];
  },
  setupProgress: (sourceTypeId) => setupProgress.get(sourceTypeId) ?? { status: "waiting" },
  catalogueEntries: (sourceTypeId) => catalogueEntries.get(sourceTypeId) ?? [],
  sourceAdded: (sourceTypeId, fields) => {
    if (addingFails.delete(sourceTypeId)) return { sourceError: "temporary", message: "the homeserver is unreachable" };
    accounts += 1;
    const plain: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const field of fields) (field.secret ? secrets : plain)[field.key] = `${field.key}-${accounts}`;
    return { plain, secrets };
  },
  sourceRemoved: (sourceTypeId, context) => {
    removed.set(sourceTypeId, [...(removed.get(sourceTypeId) ?? []), context]);
    return null;
  },
};

/** The Source Attributes the Origins name and those asked for to declare, and those asked for to archive. */
function reportedAttributes(sourceTypeId: string, origins: Origin[]): Pick<IngestResult, "declaredAttributes" | "archivedAttributes"> {
  const named = new Map<string, string>();
  if (!undeclared.delete(sourceTypeId)) for (const id of origins.flatMap((origin) => origin.attributes)) named.set(id, id);
  for (const { externalId, name } of declaring.get(sourceTypeId) ?? []) named.set(externalId, name);
  declaring.delete(sourceTypeId);
  const archivedAttributes = [...(archiving.get(sourceTypeId) ?? [])];
  archiving.delete(sourceTypeId);
  return { declaredAttributes: [...named].map(([externalId, name]) => ({ externalId, name })), archivedAttributes };
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
};

const remoteModule = fileURLToPath(new URL("./test-plugin-remote.ts", import.meta.url));

let control: Promise<Server> | undefined;

/** Where plugins in a Plugin Host ask the test, served for as long as the test process runs. */
async function controlUrl(): Promise<string> {
  control ??= new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const { question, sourceTypeId, args } = decode(Buffer.concat(chunks).toString("utf8")) as { question: keyof Questions; sourceTypeId: string; args: never };
        void answer(question, sourceTypeId, args).then((value) => {
          response.writeHead(200).end(encode(value));
        });
      });
    });
    server.unref();
    server.listen(0, "127.0.0.1", () => { resolve(server); });
  });
  const { port } = (await control).address() as AddressInfo;
  return `http://127.0.0.1:${port}/`;
}

/** Writes a package with a test plugin into a directory the test Plugin Repository publishes. */
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
  await writeFile(
    join(packageDirectory, "index.ts"),
    `import { remoteTestSourcePlugin } from ${JSON.stringify(remoteModule)};\n` +
      `export default remoteTestSourcePlugin(${JSON.stringify(await controlUrl())}, { sourceTypeId: ${JSON.stringify(plugin.sourceTypeId)}${configuration}${silentApplies}${setupSteps}${catalogue}${liveSteps} });\n`,
  );
}
