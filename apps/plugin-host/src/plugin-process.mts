/**
 * The process one plugin runs in. The manager starts it with plain Node under the permission
 * model, so it imports nothing but Node's built-ins and the plugin's bundle, whose path is its one
 * argument. It answers the manager's calls over the IPC channel, whose structured clone keeps
 * dates and binary data.
 */
import { pathToFileURL } from "node:url";

type Plugin = {
  identity: unknown;
  configuration: { version: number; fields: { key: string; choices?: (context: unknown) => Promise<unknown> }[]; migrations?: Record<number, (plain: unknown) => unknown> };
  setupSteps: { id: string; title: unknown; description: unknown; progress?: (context: unknown) => Promise<unknown> }[];
  ingestion: { mode: "polling"; suggestedIntervalSeconds: number; poll(context: unknown): Promise<unknown> } | { mode: "push" };
  health: unknown;
  catalogue?: { title: unknown; configKey: string; entries(): Promise<unknown> };
  sourceAdded?: (context: unknown) => Promise<unknown>;
  sourceRemoved?: (context: unknown) => Promise<void>;
};

type Request = { id: number; call: string; args: unknown[] };

const bundle = process.argv[2];
if (!bundle) throw new Error("The plugin process needs the path of a bundle.");

// The shell that set the limits leaves variables of its own; the plugin sees its temp space only.
for (const name of Object.keys(process.env)) if (name !== "TMPDIR") Reflect.deleteProperty(process.env, name);

const imported = (await import(pathToFileURL(bundle).href)) as { default?: Plugin };
const loaded = imported.default;
if (!loaded) throw new Error("The bundle has no default export.");
const plugin: Plugin = loaded;

function describe(): unknown {
  const { identity, configuration, setupSteps, ingestion, health, catalogue } = plugin;
  return {
    identity,
    configuration: {
      version: configuration.version,
      fields: configuration.fields.map(({ choices, ...field }) => ({ ...field, choices: choices !== undefined })),
      migrations: Object.keys(configuration.migrations ?? {}).map(Number),
    },
    setupSteps: setupSteps.map(({ id, title, description, progress }) => ({ id, title, description, live: progress !== undefined })),
    ingestion: ingestion.mode === "polling" ? { mode: "polling", suggestedIntervalSeconds: ingestion.suggestedIntervalSeconds } : { mode: "push" },
    health,
    catalogue: catalogue ? { title: catalogue.title, configKey: catalogue.configKey } : null,
    sourceAdded: plugin.sourceAdded !== undefined,
    sourceRemoved: plugin.sourceRemoved !== undefined,
  };
}

async function answer(call: string, args: unknown[]): Promise<unknown> {
  switch (call) {
    case "describe":
      return describe();
    case "poll":
      if (plugin.ingestion.mode !== "polling") throw new Error("The plugin does not poll.");
      return plugin.ingestion.poll(args[0]);
    case "sourceAdded":
      return plugin.sourceAdded ? plugin.sourceAdded(args[0]) : { plain: {}, secrets: {} };
    case "sourceRemoved":
      await plugin.sourceRemoved?.(args[0]);
      return null;
    case "choices":
      return (await plugin.configuration.fields.find((field) => field.key === args[0])?.choices?.(args[1])) ?? [];
    case "setupProgress":
      return (await plugin.setupSteps.find((step) => step.id === args[0])?.progress?.(args[1])) ?? null;
    case "catalogueEntries":
      return plugin.catalogue ? plugin.catalogue.entries() : [];
    case "migrate": {
      const migrate = plugin.configuration.migrations?.[args[0] as number];
      if (!migrate) throw new Error(`The plugin has no configuration migration from version ${String(args[0])}.`);
      return migrate(args[1]);
    }
    default:
      throw new Error(`Unknown call "${call}".`);
  }
}

/** A thrown value as the manager reads it; a plugin's own SDK copy makes `instanceof` useless. */
function thrown(error: unknown): { name: string; kind: unknown; message: string } {
  if (error instanceof Error) return { name: error.name, kind: (error as { kind?: unknown }).kind, message: error.message };
  return { name: "Error", kind: undefined, message: String(error) };
}

process.on("message", (message: Request) => {
  answer(message.call, message.args).then(
    (value) => process.send?.({ id: message.id, ok: true, value }),
    (error: unknown) => process.send?.({ id: message.id, ok: false, error: thrown(error) }),
  );
});
process.send?.({ ready: true });
