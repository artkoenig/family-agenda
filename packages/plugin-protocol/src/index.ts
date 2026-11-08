/**
 * The wire protocol between the core and the Plugin Host: which calls a hosted plugin answers, what
 * describes it without its code, and how values cross the wire. Dates, binary data and Source
 * errors survive a round-trip; everything else is plain JSON.
 */
import type {
  CatalogueEntry,
  Choice,
  ConfigField,
  Health,
  IngestResult,
  JsonObject,
  PluginText,
  RunContext,
  SetupProgress,
  SourcePluginIdentity,
} from "@family-agenda/source-sdk";

/** The header the core sends the shared token in, as `Bearer <token>`. */
export const authorizationHeader = "authorization";

/** A plugin as the core sees it before calling it: everything but its functions. */
export type PluginDescription = {
  identity: SourcePluginIdentity;
  configuration: {
    version: number;
    fields: (Omit<ConfigField, "choices"> & { choices: boolean })[];
    /** The versions a migration starts from. */
    migrations: number[];
  };
  setupSteps: { id: string; title: PluginText; description: PluginText; live: boolean }[];
  ingestion: { mode: "polling"; suggestedIntervalSeconds: number } | { mode: "push" };
  health: Health;
  catalogue: { title: PluginText; configKey: string } | null;
  sourceAdded: boolean;
  sourceRemoved: boolean;
};

/** What each call takes and gives. */
export type Calls = {
  poll: { args: [RunContext]; result: IngestResult };
  sourceAdded: { args: [Omit<RunContext, "syncCursor">]; result: { plain: JsonObject; secrets: Record<string, string> } };
  sourceRemoved: { args: [RunContext]; result: null };
  choices: { args: [string, RunContext]; result: Choice[] };
  setupProgress: { args: [string, RunContext]; result: SetupProgress | null };
  catalogueEntries: { args: []; result: CatalogueEntry[] };
  migrate: { args: [number, JsonObject]; result: JsonObject };
};

export type CallName = keyof Calls;

export const callNames: readonly CallName[] = ["poll", "sourceAdded", "sourceRemoved", "choices", "setupProgress", "catalogueEntries", "migrate"];

export function isCallName(name: string): name is CallName {
  return (callNames as readonly string[]).includes(name);
}

/** Why a call failed: a Source error the plugin threw, or anything else, with its message. */
export type CallFailure = { sourceError: "definite" | "temporary" | null; message: string };

/** The answer to a call. */
export type CallOutcome<T = unknown> = { ok: true; value: T } | { ok: false; failure: CallFailure };

/** What a thrown value becomes on the wire. */
export function failureOf(error: unknown): CallFailure {
  if (error instanceof Error) {
    const kind = (error as { kind?: unknown }).kind;
    const sourceError = error.name === "SourceError" && (kind === "definite" || kind === "temporary") ? kind : null;
    return { sourceError, message: error.message };
  }
  return { sourceError: null, message: String(error) };
}

const dateTag = "$date";
const bytesTag = "$bytes";
const escapeTag = "$plain";

/** JSON in which dates and binary data keep their type. */
export function encode(value: unknown): string {
  return JSON.stringify(tagged(value));
}

export function decode(text: string): unknown {
  return untagged(JSON.parse(text));
}

function tagged(value: unknown): unknown {
  if (value instanceof Date) return { [dateTag]: value.toISOString() };
  if (value instanceof Uint8Array) return { [bytesTag]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (Array.isArray(value)) return value.map(tagged);
  if (typeof value === "object" && value !== null) {
    const object = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, tagged(entry)]));
    // An object of the plugin's own that looks like a tag is wrapped, so it comes back as it was.
    return isTag(object) ? { [escapeTag]: object } : object;
  }
  return value;
}

function untagged(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(untagged);
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  if (isTag(object)) {
    const [[tag, inner]] = Object.entries(object) as [[string, unknown]];
    if (tag === dateTag) return new Date(inner as string);
    if (tag === bytesTag) return new Uint8Array(Buffer.from(inner as string, "base64"));
    return Object.fromEntries(Object.entries(inner as Record<string, unknown>).map(([key, entry]) => [key, untagged(entry)]));
  }
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, untagged(entry)]));
}

function isTag(object: object): boolean {
  const keys = Object.keys(object);
  return keys.length === 1 && [dateTag, bytesTag, escapeTag].includes(keys[0] as string);
}
