import type {
  AttributeReporting,
  InstalledSourceType,
  LoadedSourceType,
  SetupProgress,
  SourceRunContext,
  SourceRunResult,
  SourceTypeRegistry,
} from "@family-agenda/application";
import type { SourceTypeId } from "@family-agenda/domain";
import {
  endpoints,
  errorSchema,
  loadProblem,
  type Description,
  type Endpoint,
  type IngestResult,
  type RunContext,
} from "@family-agenda/plugin-contract";

/** A Source Type whose plugin runs in a container of its own, at `url` (ADR-0001). */
export type PluginBinding = { sourceTypeId: string; url: string };

type EndpointName = keyof typeof endpoints;

const sourceTypeIdPattern = /^[a-z][a-z0-9-]*$/;

/**
 * The bindings of `PLUGIN_URLS`, such as `demo=http://demo:8080,ics=http://ics:8080`: each Source
 * Type id with the base URL of its plugin container. Empty for none.
 */
export function parsePluginUrls(text: string | undefined): PluginBinding[] {
  const bindings: PluginBinding[] = [];
  for (const entry of (text ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "")) {
    const at = entry.indexOf("=");
    const sourceTypeId = entry.slice(0, Math.max(at, 0)).trim();
    const url = entry.slice(at + 1).trim();
    if (!sourceTypeIdPattern.test(sourceTypeId) || !isHttpUrl(url)) {
      throw new Error(`PLUGIN_URLS takes Source Type ids with http or https addresses, such as demo=http://demo:8080; "${entry}" is none`);
    }
    if (bindings.some((binding) => binding.sourceTypeId === sourceTypeId)) throw new Error(`PLUGIN_URLS binds "${sourceTypeId}" twice`);
    bindings.push({ sourceTypeId, url: withoutTrailingSlashes(url) });
  }
  return bindings;
}

function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (url[end - 1] === "/") end--;
  return url.slice(0, end);
}

function isHttpUrl(url: string): boolean {
  return URL.canParse(url) && /^https?:$/.test(new URL(url).protocol);
}

/** What a call to a plugin came to: its validated answer, or an error as the contract classifies it. */
export type CallResult = { ok: true; body: unknown } | { ok: false; kind: "definite" | "temporary"; message: string; unreachable: boolean };

export type PluginContainerOptions = {
  /** Replaces the timeouts of the plugin contract, such as for a test of a plugin that does not answer. */
  timeoutsMs?: Partial<Record<EndpointName, number>>;
};

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}

async function textOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Calls one endpoint of the plugin at `url`, validating the request and the answer against the
 * plugin contract. A 4xx with `definite` is a definite error; a 5xx, a timeout or no answer is a
 * temporary one, and so is a 4xx that does not say it is definite.
 */
export async function callPlugin(url: string, name: EndpointName, body: unknown, options: PluginContainerOptions = {}): Promise<CallResult> {
  const endpoint: Endpoint = endpoints[name];
  if (endpoint.request !== undefined) endpoint.request.parse(body);
  const timeoutMs = options.timeoutsMs?.[name] ?? endpoint.timeoutMs;
  let response: Response;
  try {
    response = await fetch(url + endpoint.path, {
      method: endpoint.method.toUpperCase(),
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      ...(endpoint.request === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const why = error instanceof Error && error.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : messageOf(error);
    return { ok: false, kind: "temporary", message: `The plugin at ${url} is not reachable: ${why}`, unreachable: true };
  }
  return answerOf(url, name, endpoint, response);
}

async function answerOf(url: string, name: EndpointName, endpoint: Endpoint, response: Response): Promise<CallResult> {
  const answer = await textOf(response);
  if (response.status >= 400) return errorOf(name, response.status, answer);
  if (endpoint.response === undefined) return { ok: true, body: undefined };
  const parsed = endpoint.response.safeParse(answer);
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, kind: "definite", message: `The plugin at ${url} answered ${name} invalidly: ${parsed.error.message}`, unreachable: false };
}

function errorOf(name: EndpointName, status: number, answer: unknown): CallResult {
  const error = errorSchema.safeParse(answer);
  const definite = status < 500 && error.success && error.data.kind === "definite";
  const message = error.success ? error.data.message : `${name} answered ${status}`;
  return { ok: false, kind: definite ? "definite" : "temporary", message, unreachable: status >= 500 };
}

type State = {
  /** The last description the plugin gave; null before it gave one. */
  description: Description | null;
  /** Why the description keeps the core from loading the plugin, such as another Source Type id. */
  problem: string | null;
  /** Why the plugin did not answer the last time it was asked; null if it did. */
  unreachable: string | null;
};

/**
 * The Source Types whose plugins run in containers (ADR-0001), bound to their URLs by `PLUGIN_URLS`.
 * The core asks each for its description every time it loads it, uncached: a plugin is loadable
 * while it describes the Source Type it is bound to, built for a plugin contract the core implements.
 */
export class PluginContainers implements SourceTypeRegistry {
  private readonly states = new Map<string, State>();

  private constructor(
    private readonly bindings: PluginBinding[],
    private readonly options: PluginContainerOptions,
  ) {}

  /** Asks every bound plugin for its description, so that the Admin area has something to show. */
  static async connect(bindings: PluginBinding[], options: PluginContainerOptions = {}): Promise<PluginContainers> {
    const containers = new PluginContainers(bindings, options);
    await Promise.all(bindings.map((binding) => containers.describe(binding)));
    return containers;
  }

  installed(): InstalledSourceType[] {
    return this.bindings.map(({ sourceTypeId }) => {
      const { description, problem, unreachable } = this.states.get(sourceTypeId) ?? { description: null, problem: null, unreachable: null };
      return {
        id: sourceTypeId as SourceTypeId,
        displayName: description?.displayName ?? sourceTypeId,
        description: description?.description ?? "",
        version: description?.version ?? "",
        needsLlm: description?.needsLlm ?? false,
        riskNotice: description?.riskNotice ?? null,
        notLoadable: problem ?? (description === null ? "the plugin has not described itself yet" : null),
        notReachable: unreachable,
      };
    });
  }

  async load(id: SourceTypeId): Promise<{ ok: true; sourceType: LoadedSourceType } | { ok: false }> {
    const binding = this.bindings.find((candidate) => candidate.sourceTypeId === id);
    if (!binding) return { ok: false };
    const { description, problem } = await this.describe(binding);
    if (description === null || problem !== null) return { ok: false };
    return { ok: true, sourceType: loadedSourceType(binding.url, description, this.options) };
  }

  /** Asks the plugin for its description and checks it; one that does not answer keeps the last it gave. */
  private async describe(binding: PluginBinding): Promise<State> {
    const previous = this.states.get(binding.sourceTypeId) ?? { description: null, problem: null, unreachable: null };
    const answer = await callPlugin(binding.url, "description", undefined, this.options);
    let state: State;
    if (answer.ok) {
      const description = answer.body as Description;
      state = { description, problem: descriptionProblem(binding, description), unreachable: null };
    } else if (answer.unreachable) {
      state = { ...previous, unreachable: answer.message };
    } else {
      state = { description: null, problem: answer.message, unreachable: null };
    }
    this.states.set(binding.sourceTypeId, state);
    return state;
  }
}

/** Why the core does not load a plugin that describes itself so, or null where it does. */
export function descriptionProblem(binding: PluginBinding, description: Description): string | null {
  if (description.sourceTypeId !== binding.sourceTypeId) {
    return `the plugin at ${binding.url} is for Source Type "${description.sourceTypeId}", but it is bound to "${binding.sourceTypeId}"`;
  }
  return loadProblem(description.contractVersion);
}

function runContextOf(context: Omit<SourceRunContext, "syncCursor"> & { syncCursor?: string | null }): RunContext {
  const { plain, secrets, syncCursor = null, now, timeZone } = context;
  return { config: { plain, secrets }, syncCursor, now: now.toISOString(), timeZone };
}

/** A Source Type as the core uses it, every function a call to its plugin container. */
function loadedSourceType(url: string, description: Description, options: PluginContainerOptions): LoadedSourceType {
  const call = (name: EndpointName, body?: unknown) => callPlugin(url, name, body, options);
  const { configuration, ingestion, catalogue } = description;
  return {
    configuration: {
      version: configuration.version,
      fields: configuration.fields.map(({ key, label, secret, required, description: about, setByPlugin, hasChoices }) => ({
        key,
        label,
        secret,
        required,
        description: about ?? null,
        setByPlugin: setByPlugin === true,
        choice: hasChoices,
      })),
    },
    setupSteps: description.setupSteps.map(({ id, title, description: about, live }) => ({ id, title, description: about, live })),
    migrateConfig(plain, fromVersion) {
      if (fromVersion >= configuration.version) return plain;
      throw new Error("migrating the configuration of a plugin container is not supported yet");
    },
    ingestion:
      ingestion.mode === "polling"
        ? {
            mode: "polling",
            suggestedIntervalSeconds: ingestion.suggestedIntervalSeconds,
            poll: async (context, attributes) => {
              const answer = await call("poll", runContextOf(context));
              if (!answer.ok) return { ok: false, kind: answer.kind, message: answer.message };
              return ingested(answer.body as IngestResult, attributes);
            },
          }
        : { mode: "push" },
    silentApplies: description.silentApplies,
    catalogue: catalogue
      ? {
          title: catalogue.title,
          configKey: catalogue.configKey,
          async entries() {
            const answer = await call("catalogueEntries");
            if (!answer.ok) return [];
            const { entries } = answer.body as { entries: { id: string; displayName: string; description: string; installed: boolean; riskNotice?: string }[] };
            return entries.map((entry) => ({ ...entry, riskNotice: entry.riskNotice ?? null }));
          },
        }
      : null,
    services: null,
    async choices(field, context) {
      const answer = await call("fieldChoices", { field, context: runContextOf(context) });
      return answer.ok ? (answer.body as { choices: { value: string; label: string }[] }).choices : [];
    },
    async setupProgress(stepId, context) {
      const answer = await call("setupProgress", { stepId, context: runContextOf(context) });
      if (!answer.ok) return { status: "failed", message: answer.message };
      return progressOf(answer.body as Progress);
    },
    async sourceAdded(context) {
      if (!description.endpoints.sourceAdded) return { ok: true, plain: {}, secrets: {} };
      const { config, now, timeZone } = runContextOf(context);
      const answer = await call("sourceAdded", { config, now, timeZone });
      if (!answer.ok) return { ok: false, message: answer.message };
      const prepared = answer.body as { plain: Record<string, unknown>; secrets: Record<string, string> };
      return { ok: true, plain: prepared.plain, secrets: prepared.secrets };
    },
    async sourceRemoved(context) {
      if (!description.endpoints.sourceRemoved) return;
      const answer = await call("sourceRemoved", runContextOf(context));
      if (!answer.ok) console.warn(`Cleaning up after a removed Source of type "${description.sourceTypeId}" failed: ${answer.message}`);
    },
  };
}

type Progress = { status: "waiting"; qrCode?: string; message?: string } | { status: "done"; message?: string } | { status: "failed"; message: string };

function progressOf(progress: Progress): SetupProgress {
  if (progress.status === "waiting") return { status: "waiting", qrCode: progress.qrCode ?? null, message: progress.message ?? null };
  if (progress.status === "done") return { status: "done", message: progress.message ?? null };
  return progress;
}

/** A plugin's answer to `poll` as the core records it, its Source Attributes reported first. */
async function ingested(result: IngestResult, attributes: AttributeReporting): Promise<SourceRunResult> {
  const timeless = result.sourceRecords.filter((record) => record.content.kind === "raw-message" && record.occurredAt === undefined);
  if (timeless.length > 0) {
    return { ok: false, kind: "definite", message: `The plugin emitted messages without a time: ${timeless.map((record) => record.externalId).join(", ")}` };
  }
  if (result.attributes) {
    await attributes.declare(result.attributes.declared);
    for (const externalId of result.attributes.archived) await attributes.archive(externalId);
  }
  return {
    ok: true,
    syncCursor: result.syncCursor,
    withdrawn: result.withdrawn ?? [],
    secrets: result.secrets ?? {},
    origins: result.sourceRecords.map((record) => ({
      externalId: record.externalId,
      attributes: record.attributes,
      sender: record.sender ?? null,
      subject: record.subject ?? null,
      link: record.link ?? null,
      // A stated Item has no time of its own, even if the plugin gives one.
      occurredAt: record.content.kind === "stated" || record.occurredAt === undefined ? null : new Date(record.occurredAt),
      stated: record.content.kind === "stated" ? (record.content.stated as Record<string, unknown>) : null,
      message:
        record.content.kind === "raw-message"
          ? {
              text: record.content.text,
              attachments: record.content.attachments.map(({ filename, contentType, bytes }) => ({ filename, contentType, bytes: new Uint8Array(Buffer.from(bytes, "base64")) })),
            }
          : null,
    })),
  };
}

/**
 * The Source Types of several registries, such as plugin containers beside plugins in-process while
 * both kinds exist (expand–contract). The first registry naming a Source Type id wins.
 */
export class CombinedRegistry implements SourceTypeRegistry {
  constructor(private readonly registries: SourceTypeRegistry[]) {}

  installed(): InstalledSourceType[] {
    const seen = new Set<string>();
    return this.registries.flatMap((registry) =>
      registry.installed().filter((type) => {
        if (seen.has(type.id)) return false;
        seen.add(type.id);
        return true;
      }),
    );
  }

  async load(id: SourceTypeId): Promise<{ ok: true; sourceType: LoadedSourceType } | { ok: false }> {
    const registry = this.registries.find((candidate) => candidate.installed().some((type) => type.id === id));
    return registry ? registry.load(id) : { ok: false };
  }
}
