import {
  authorizationHeader,
  decode,
  encode,
  type CallFailure,
  type CallName,
  type AvailablePlugin,
  type CallOutcome,
  type Calls,
  type PluginDescription,
} from "@family-agenda/plugin-protocol";
import { SourceError, statedKinds, type JsonObject, type RunContext, type SourcePlugin, type SourcePluginManifest } from "@family-agenda/source-sdk";

export type PluginHostConfig = {
  /** Where the Plugin Host listens, such as `http://plugin-host:4100`. */
  url: string;
  /** The token shared with the Plugin Host. */
  token: string;
  fetch?: typeof globalThis.fetch;
};

/** A plugin the Plugin Host runs, as the core calls it, with its configuration migration, which the SDK keeps synchronous. */
export type HostedPlugin = { plugin: SourcePlugin; migrate(fromVersion: number, plain: JsonObject): Promise<JsonObject> };

/** A plugin the Plugin Host offers: the manifest it was published with, and the plugin to call. */
export type RemotePlugin = { manifest: SourcePluginManifest; hosted: HostedPlugin };

/** Reaches the Plugin Host's manager over its internal channel. */
export class PluginHostClient {
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly config: PluginHostConfig) {
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  /**
   * The plugins the host installed from the Plugin Repository. A host that is still starting is
   * asked again, `attempts` times in all.
   */
  async available({ attempts = 30, delayMs = 1_000 } = {}): Promise<RemotePlugin[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.request("/plugins", "GET");
        const listed = decode(await response.text()) as AvailablePlugin[];
        return listed.map(({ manifest, description }) => ({ manifest, hosted: this.hosted(manifest.identity.sourceTypeId, description) }));
      } catch (error) {
        if (attempt >= attempts || !(error instanceof SourceError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private hosted(id: string, description: PluginDescription): HostedPlugin {
    const call = async <C extends CallName>(name: C, ...args: Calls[C]["args"]): Promise<Calls[C]["result"]> => {
      const outcome = await this.call(id, name, args);
      if (!outcome.ok) throw errorOf(outcome.failure);
      return outcome.value as Calls[C]["result"];
    };
    return { plugin: pluginOf(description, call), migrate: (from, plain) => call("migrate", from, plain) };
  }

  private async call(id: string, name: CallName, args: unknown[]): Promise<CallOutcome> {
    const response = await this.request(`/plugins/${encodeURIComponent(id)}/${name}`, "POST", encode(args));
    // The host lost the plugin, as when it failed to start after a restart: try again later.
    if (response.status === 404) throw SourceError.temporary(`The Plugin Host has no plugin "${id}".`);
    if (!response.ok) throw new Error(`The Plugin Host refused the call "${name}" with status ${response.status}.`);
    return decode(await response.text()) as CallOutcome;
  }

  private async request(path: string, method: string, body?: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(new URL(path, this.config.url), { method, ...(body === undefined ? {} : { body }), headers: { [authorizationHeader]: `Bearer ${this.config.token}` } });
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
