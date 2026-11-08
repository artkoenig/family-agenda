import { build } from "esbuild";
import {
  authorizationHeader,
  decode,
  encode,
  type CallFailure,
  type CallName,
  type CallOutcome,
  type Calls,
  type PluginDescription,
} from "@family-agenda/plugin-protocol";
import { SourceError, statedKinds, type JsonObject, type RunContext, type SourcePlugin } from "@family-agenda/source-sdk";

export type PluginHostConfig = {
  /** Where the Plugin Host listens, such as `http://plugin-host:4100`. */
  url: string;
  /** The token shared with the Plugin Host. */
  token: string;
  /** The Source Types run there rather than in this process. */
  sourceTypes: string[];
  fetch?: typeof globalThis.fetch;
};

/** A plugin the Plugin Host runs, as the core calls it, with its configuration migration, which the SDK keeps synchronous. */
export type HostedPlugin = { plugin: SourcePlugin; migrate(fromVersion: number, plain: JsonObject): Promise<JsonObject> };

/** One file holding a plugin's entry module and everything it imports, the SDK included. */
export async function bundlePlugin(entry: string): Promise<string> {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  const [output] = result.outputFiles;
  if (!output) throw new Error(`Bundling ${entry} gave no output.`);
  return output.text;
}

/** Reaches the Plugin Host's manager over its internal channel. */
export class PluginHostClient {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly config: Omit<PluginHostConfig, "sourceTypes">) {
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  /** Installs a plugin's bundle and gives it back as a plugin whose functions call the host. */
  async hosted(id: string, bundle: string): Promise<HostedPlugin> {
    const description = await this.install(id, bundle);
    const call = async <C extends CallName>(name: C, ...args: Calls[C]["args"]): Promise<Calls[C]["result"]> => {
      let outcome = await this.call(id, name, args);
      // The host lost its plugins, as on a restart: install the bundle again.
      if (outcome === null) {
        await this.install(id, bundle);
        outcome = await this.call(id, name, args);
      }
      if (outcome === null) throw new Error(`The Plugin Host has no plugin "${id}".`);
      if (!outcome.ok) throw errorOf(outcome.failure);
      return outcome.value as Calls[C]["result"];
    };
    return { plugin: pluginOf(description, call), migrate: (from, plain) => call("migrate", from, plain) };
  }

  private async install(id: string, bundle: string): Promise<PluginDescription> {
    const response = await this.request(`/plugins/${encodeURIComponent(id)}`, "PUT", bundle);
    const installed = decode(await response.text()) as { ok: true; description: PluginDescription } | { ok: false; failure: CallFailure };
    if (!installed.ok) throw new Error(`The Plugin Host could not install "${id}": ${installed.failure.message}`);
    return installed.description;
  }

  private async call(id: string, name: CallName, args: unknown[]): Promise<CallOutcome | null> {
    const response = await this.request(`/plugins/${encodeURIComponent(id)}/${name}`, "POST", encode(args));
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`The Plugin Host refused the call "${name}" with status ${response.status}.`);
    return decode(await response.text()) as CallOutcome;
  }

  private async request(path: string, method: string, body: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(new URL(path, this.config.url), { method, body, headers: { [authorizationHeader]: `Bearer ${this.config.token}` } });
    } catch (error) {
      throw SourceError.temporary(`The Plugin Host cannot be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401) throw new Error("The Plugin Host refused the token; PLUGIN_HOST_TOKEN must be the same for it, api and worker.");
    if (response.status >= 500) throw SourceError.temporary(`The Plugin Host failed with status ${response.status}.`);
    return response;
  }
}

function errorOf(failure: CallFailure): Error {
  return failure.sourceError ? new SourceError(failure.message, failure.sourceError) : new Error(failure.message);
}

type Call = <C extends CallName>(name: C, ...args: Calls[C]["args"]) => Promise<Calls[C]["result"]>;

function pluginOf(description: PluginDescription, call: Call): SourcePlugin {
  const { identity, configuration, setupSteps, ingestion, health, catalogue } = description;
  return {
    identity,
    configuration: {
      version: configuration.version,
      fields: configuration.fields.map(({ choices, ...field }) => ({
        ...field,
        ...(choices ? { choices: (context: RunContext) => call("choices", field.key, context) } : {}),
      })),
      // Present for the checks only; the core migrates through `HostedPlugin.migrate`.
      migrations: Object.fromEntries(configuration.migrations.map((from) => [from, () => { throw new Error("A hosted plugin migrates asynchronously."); }])),
    },
    setupSteps: setupSteps.map(({ id, title, description: text, live }) => ({
      id,
      title,
      description: text,
      ...(live ? { progress: async (context: RunContext) => (await call("setupProgress", id, context)) ?? { status: "failed", message: `The setup step "${id}" is not driven live.` } } : {}),
    })),
    ingestion:
      ingestion.mode === "polling"
        ? { mode: "polling", suggestedIntervalSeconds: ingestion.suggestedIntervalSeconds, poll: async (context) => checkedResult(await call("poll", context)) }
        : { mode: "push", receive: () => Promise.reject(new Error("A hosted plugin cannot receive pushes yet.")) },
    health,
    ...(catalogue ? { catalogue: { ...catalogue, entries: () => call("catalogueEntries") } } : {}),
    ...(description.sourceAdded ? { sourceAdded: (context: Omit<RunContext, "syncCursor">) => call("sourceAdded", context) } : {}),
    ...(description.sourceRemoved ? { sourceRemoved: async (context: RunContext) => { await call("sourceRemoved", context); } } : {}),
  };
}

/**
 * What another process sent as a poll result, if it has the shape of one; the core checks the
 * Origins in it as it checks those of a plugin it runs itself.
 */
function checkedResult(value: unknown): Calls["poll"]["result"] {
  const problems = resultProblems(value);
  if (problems.length > 0) throw SourceError.definite(`The plugin returned no valid result: ${problems.join("; ")}`);
  return value as Calls["poll"]["result"];
}

function resultProblems(value: unknown): string[] {
  if (!isObject(value)) return ["it is no object"];
  const problems: string[] = [];
  if (!Array.isArray(value.origins)) problems.push("its origins are no list");
  else value.origins.forEach((origin, index) => problems.push(...originShapeProblems(origin).map((problem) => `Origin ${index}: ${problem}`)));
  if (value.syncCursor !== null && typeof value.syncCursor !== "string") problems.push("its sync cursor is no text");
  for (const key of ["declaredAttributes", "archivedAttributes", "withdrawn"] as const) {
    if (value[key] !== undefined && !Array.isArray(value[key])) problems.push(`its ${key} are no list`);
  }
  return problems;
}

function originShapeProblems(origin: unknown): string[] {
  if (!isObject(origin)) return ["it is no object"];
  const problems: string[] = [];
  if (typeof origin.externalId !== "string") problems.push("its external id is no text");
  if (!isTextList(origin.attributes)) problems.push("its Source Attributes are no list of texts");
  problems.push(...optionalTextProblems(origin));
  if (origin.occurredAt !== undefined && !(origin.occurredAt instanceof Date)) problems.push("its time is no date");
  problems.push(...contentShapeProblems(origin.content));
  return problems;
}

function optionalTextProblems(origin: Record<string, unknown>): string[] {
  return (["sender", "subject", "link"] as const).filter((key) => origin[key] !== undefined && typeof origin[key] !== "string").map((key) => `its ${key} is no text`);
}

function contentShapeProblems(content: unknown): string[] {
  if (!isObject(content)) return ["it has no content"];
  if (content.kind === "stated") return isStated(content.stated) ? [] : ["it states no known kind of Item"];
  if (content.kind !== "raw-message") return ["its content is of no known kind"];
  if (typeof content.text !== "string") return ["its text is no text"];
  return Array.isArray(content.attachments) && content.attachments.every(isAttachment) ? [] : ["its attachments are invalid"];
}

function isStated(stated: unknown): boolean {
  return isObject(stated) && (statedKinds as readonly unknown[]).includes(stated.kind);
}

function isAttachment(attachment: unknown): boolean {
  return isObject(attachment) && typeof attachment.filename === "string" && typeof attachment.contentType === "string" && attachment.bytes instanceof Uint8Array;
}

function isTextList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
