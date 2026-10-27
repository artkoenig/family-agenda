/**
 * The contract a Source plugin implements (ADR-0010). It is the only Family Agenda package a
 * plugin may import.
 */
export const sdkVersion = "0.3.0";

/**
 * A text the Admin area shows: plain, or per language as `{ en: "Calendar", de: "Kalender" }`.
 * The Family Language picks one; a language the text lacks falls back to English, which every
 * per-language text has. A plain string shows the same in every language.
 */
export type PluginText = string | { en: string; [language: string]: string | undefined };

/** The English of a text, or the text itself if it is plain. */
export function englishOf(text: PluginText): string {
  return typeof text === "string" ? text : text.en;
}

export type SourcePluginIdentity = {
  /** Stable id of the Source Type, such as `ics`. Never changes once released. */
  sourceTypeId: string;
  displayName: PluginText;
  /** The plugin's own version. */
  version: string;
  /** The `sdkVersion` the plugin was built against. */
  sdkVersion: string;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * One field of a Source's configuration. The Admin area renders the wizard's Source step from
 * these. Secret fields are kept in the SecretStore and reach the plugin only at run time.
 */
export type ConfigField = {
  key: string;
  label: PluginText;
  secret: boolean;
  required: boolean;
  description?: PluginText;
};

export type Configuration = {
  /** Raised whenever the plain configuration changes shape, starting at 1. */
  version: number;
  fields: ConfigField[];
  /**
   * Turns the plain configuration of the version given as key into that of the next version.
   * The core runs them at startup, in order, for every Source stored with an older version.
   */
  migrations?: Record<number, (plain: JsonObject) => JsonObject>;
};

/** An interactive step the wizard shows, such as pairing an account by QR code. */
export type SetupStep = { id: string; title: PluginText; description: PluginText };

/** What a plugin gets for one Source on each run. */
export type RunContext = {
  config: { plain: JsonObject; secrets: Record<string, string> };
  /** The opaque state the plugin returned last time for this Source, such as a sync token. */
  state: string | null;
  /** The time of the run, as the Instance's clock tells it. */
  now: Date;
  /** The IANA time zone the Family lives in, for times a Source gives without one. */
  timeZone: string;
};

export type IngestResult = { origins: Origin[]; state: string | null };

export type Ingestion =
  | {
      mode: "polling";
      /** How often the worker polls a Source by default; an Admin can change it. */
      suggestedIntervalSeconds: number;
      poll(context: RunContext): Promise<IngestResult>;
    }
  | {
      /** The plugin's own process delivers to an ingest endpoint the Instance gives each Source. */
      mode: "push";
      receive(context: RunContext, payload: Uint8Array): Promise<IngestResult>;
    };

export type Attachment = { filename: string; contentType: string; bytes: Uint8Array };

export const itemKinds = ["event", "lesson", "timetable-change", "task", "notice"] as const;

export type ItemKind = (typeof itemKinds)[number];

export const revisionActions = ["create", "change", "move", "cancel"] as const;

/**
 * One statement about an Item from a structured Source (ADR-0009), made at the time of its
 * Origin. A create states the Item exists (again), a change or move states some of its fields,
 * and a cancel cancels it. The core folds an Item's Revisions field by field, newest first.
 */
export type PluginRevision = {
  itemKind: ItemKind;
  /** Identifies the Item within the Source, so that later Revisions reach the same Item. */
  itemKey: string;
  action: (typeof revisionActions)[number];
  /** The Item kind's fields this Revision states, such as `EventFields` for an Event. */
  fields: JsonObject;
};

/**
 * When an Event takes place: between two ISO 8601 instants, or on whole days given as
 * `YYYY-MM-DD` in the Family's time zone, both days included.
 */
export type EventSpan =
  | { allDay: false; start: string; end: string }
  | { allDay: true; firstDay: string; lastDay: string };

/**
 * The fields of an Event. A create states `title` and `span`, a move states `span`; a change
 * states any of them. A Revision with other fields, or invalid ones, is rejected.
 */
export type EventFields = { title?: string; span?: EventSpan; place?: string | null };

/** One appearance of an Item in a Source. */
export type Origin = {
  /** Identifies the Origin within its Source, such as a message id. */
  externalId: string;
  occurredAt: Date;
  /** Values of the plugin's Origin attributes, which Attribution Rules match on. */
  attributes: Record<string, string>;
  /** An `http` or `https` address where the Family can look at the original, if there is one. */
  link?: string;
  content:
    | {
        /** A message to extract Items from, such as a mail; its time is the send time. */
        kind: "raw-message";
        text: string;
        attachments: Attachment[];
        /**
         * The conversation it belongs to within the Source, such as a mail thread, so that a later
         * message can update the Items an earlier one stated.
         */
        thread?: string;
      }
    | { kind: "revisions"; revisions: PluginRevision[] };
};

/** Something an Attribution Rule can match on, such as a sender or a calendar. */
export type OriginAttribute = {
  key: string;
  label: PluginText;
  /** The values the plugin knows of, such as recent senders, offered in the Attribution Rule form. */
  knownValues(context: RunContext): Promise<{ value: string; label: string }[]>;
};

export type Health = {
  /** Whether a Source of this type counts as Silent when no Origins arrive for a while. */
  silentApplies: boolean;
};

/**
 * What a plugin throws when a run fails. A definite error, such as a wrong password, needs an
 * Admin; a temporary one, such as a timeout, is retried.
 */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly kind: "definite" | "temporary",
  ) {
    super(message);
    this.name = "SourceError";
  }

  static definite(message: string): SourceError {
    return new SourceError(message, "definite");
  }

  static temporary(message: string): SourceError {
    return new SourceError(message, "temporary");
  }
}

export interface SourcePlugin {
  identity: SourcePluginIdentity;
  configuration: Configuration;
  setupSteps: SetupStep[];
  ingestion: Ingestion;
  originAttributes: OriginAttribute[];
  health: Health;
}

const sourceTypeIdPattern = /^[a-z][a-z0-9-]*$/;

/** Problems that keep a plugin from being loaded, such as an incompatible SDK version. */
export function problemsWith(plugin: SourcePlugin): string[] {
  const { identity, configuration, ingestion } = plugin;
  const problems = problemsWithIdentity(identity);
  const keys = new Set<string>();
  for (const field of configuration.fields) {
    if (keys.has(field.key)) problems.push(`configuration field "${field.key}" is declared twice`);
    keys.add(field.key);
  }
  if (!Number.isInteger(configuration.version) || configuration.version < 1) {
    problems.push("the configuration version must be a whole number from 1");
  }
  for (let from = 1; from < configuration.version; from++) {
    if (!configuration.migrations?.[from]) problems.push(`no configuration migration from version ${from}`);
  }
  if (ingestion.mode === "polling" && !(ingestion.suggestedIntervalSeconds > 0)) {
    problems.push("the suggested polling interval must be positive");
  }
  return problems;
}

function problemsWithIdentity(identity: SourcePluginIdentity): string[] {
  const problems: string[] = [];
  if (!sourceTypeIdPattern.test(identity.sourceTypeId)) {
    problems.push(`Source Type id "${identity.sourceTypeId}" is not lowercase kebab-case`);
  }
  if (englishOf(identity.displayName).trim() === "") problems.push("display name is empty");
  if (!isCompatible(identity.sdkVersion)) {
    problems.push(`built for SDK ${identity.sdkVersion}, but this is SDK ${sdkVersion}`);
  }
  return problems;
}

/** Problems with an Origin a plugin emitted. */
export function problemsWithOrigin(origin: Origin): string[] {
  const problems: string[] = [];
  if (origin.externalId === "") problems.push("the Origin has no external id");
  if (Number.isNaN(origin.occurredAt.getTime())) problems.push("the Origin has no valid time");
  if (origin.content.kind === "revisions") {
    if (origin.content.revisions.length === 0) problems.push("the Origin carries no Revisions");
    for (const revision of origin.content.revisions) {
      if (!(itemKinds as readonly string[]).includes(revision.itemKind)) {
        problems.push(`"${revision.itemKind}" is no Item kind`);
      }
      if (!(revisionActions as readonly string[]).includes(revision.action)) {
        problems.push(`"${revision.action}" is no Revision action`);
      }
      if (revision.itemKey === "") problems.push("a Revision has no Item key");
    }
  }
  if (origin.link !== undefined && !/^https?:\/\//i.test(origin.link)) {
    problems.push("the Origin's link is no http or https address");
  }
  return problems;
}

/**
 * Whether a plugin built for `version` runs on this SDK: the same major, and no newer minor,
 * whose additions this SDK would lack. While the major is 0, every minor may break.
 */
function isCompatible(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  const [ownMajor, ownMinor] = sdkVersion.split(".").map(Number);
  if (major === undefined || minor === undefined || major !== ownMajor) return false;
  return major === 0 ? minor === ownMinor : minor <= (ownMinor ?? 0);
}

/**
 * What a plugin's `package.json` declares under `familyAgenda.sourcePlugin`, read without
 * loading the plugin's code. The plugin's version is the package's.
 */
export type SourcePluginManifest = {
  /** The module, relative to the package, whose default export is the `SourcePlugin`. */
  entry: string;
  identity: SourcePluginIdentity;
  description: PluginText;
  /** Whether its Sources need the LLM endpoint, as for extracting Items from raw messages. */
  needsLlm: boolean;
  /** Shown before an Admin can enable the Source Type, such as for an unofficial client. */
  riskNotice?: PluginText;
  /**
   * Whether the entry is an ES module, by `"type": "module"` or an `.mjs` or `.mts` entry. Only ES
   * modules share the Instance's SDK, so only they are loadable.
   */
  esModule: boolean;
};

export type ManifestResult =
  | { ok: true; manifest: SourcePluginManifest }
  | { ok: false; problem: "no-manifest" }
  | { ok: false; problem: "invalid-manifest"; sourceTypeId?: string; details: string[] };

export function parseManifest(packageJson: unknown): ManifestResult {
  const pkg = isObject(packageJson) ? packageJson : {};
  const familyAgenda = isObject(pkg.familyAgenda) ? pkg.familyAgenda : {};
  const raw = familyAgenda.sourcePlugin;
  if (!isObject(raw)) return { ok: false, problem: "no-manifest" };

  const details: string[] = [];
  const text = (key: string, value: unknown): string => {
    if (typeof value === "string" && value.trim() !== "") return value;
    details.push(`${key} is missing`);
    return "";
  };
  /** A text the Admin area shows: plain, or per language with English. */
  const shown = (key: string, value: unknown): PluginText => {
    if (!isObject(value)) return text(key, value);
    const valid =
      typeof value.en === "string" && value.en.trim() !== "" && Object.values(value).every((v) => typeof v === "string");
    if (valid) return value as PluginText;
    details.push(`${key} is no text: give a string, or strings by language with "en" among them`);
    return "";
  };
  const entry = text("entry", raw.entry);
  const sourceTypeId = text("sourceTypeId", raw.sourceTypeId);
  const displayName = shown("displayName", raw.displayName);
  const sdk = text("sdkVersion", raw.sdkVersion);
  const description = shown("description", raw.description);
  const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  if (raw.needsLlm !== undefined && typeof raw.needsLlm !== "boolean") details.push("needsLlm is not true or false");
  const riskNotice = raw.riskNotice === undefined ? undefined : shown("riskNotice", raw.riskNotice);
  if (details.length > 0) {
    return { ok: false, problem: "invalid-manifest", ...(sourceTypeId ? { sourceTypeId } : {}), details };
  }
  return {
    ok: true,
    manifest: {
      entry,
      identity: { sourceTypeId, displayName, version, sdkVersion: sdk },
      description,
      needsLlm: raw.needsLlm === true,
      esModule: pkg.type === "module" || /\.m[jt]s$/.test(entry),
      ...(riskNotice !== undefined ? { riskNotice } : {}),
    },
  };
}

/** Problems that keep a plugin from being loaded, found in its manifest alone. */
export function problemsWithManifest(manifest: SourcePluginManifest): string[] {
  const problems = problemsWithIdentity(manifest.identity);
  if (!manifest.esModule) problems.push('the package is no ES module; set "type": "module" in its package.json');
  return problems;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
