/**
 * The contract a Source plugin implements. It is the only Family Agenda package a
 * plugin may import.
 */
export const sdkVersion = "2.0.0";

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
  /**
   * Set by the plugin's `sourceAdded` rather than by an Admin, such as an account the plugin
   * creates for the Source; the form never shows it.
   */
  setByPlugin?: boolean;
  /**
   * Makes a plain field a choice among values the plugin knows for an existing Source, such as
   * the chats of a linked account; its value is the list of the chosen ones. A Source being added
   * has none to offer yet.
   */
  choices?: (context: RunContext) => Promise<Choice[]>;
};

/** A value a plugin offers, with how it names it. */
export type Choice = { value: string; label: string };

/**
 * What an Admin enables one by one within a Source Type, such as the Messengers the Matrix plugin
 * reads through bridges. Each Source uses one entry, named by a plain field.
 */
export type Catalogue = {
  /** What its entries are, such as "Messengers". */
  title: PluginText;
  /** The plain field naming the entry a Source uses; the form offers the enabled entries for it. */
  configKey: string;
  /** Every entry the plugin supports, and whether the Instance has what it needs installed. */
  entries(): Promise<CatalogueEntry[]>;
};

export type CatalogueEntry = {
  /** Stable id of the entry, such as `whatsapp`. */
  id: string;
  displayName: PluginText;
  description: PluginText;
  /** Whether what the entry needs runs on the Instance, such as its bridge. */
  installed: boolean;
  /** Shown before an Admin can enable it, such as for an unofficial client. */
  riskNotice?: PluginText;
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
export type SetupStep = {
  id: string;
  title: PluginText;
  description: PluginText;
  /**
   * Drives the step live for a Source that exists, such as a QR code login: says what to show
   * now. The Admin area asks again every few seconds until the step is done or has failed.
   */
  progress?: (context: RunContext) => Promise<SetupProgress>;
};

export type SetupProgress =
  /** A QR code to scan, or what is awaited. */
  | { status: "waiting"; qrCode?: string; message?: PluginText }
  | { status: "done"; message?: PluginText }
  | { status: "failed"; message: PluginText };

/** What a plugin gets for one Source on each run. */
export type RunContext = {
  config: { plain: JsonObject; secrets: Record<string, string> };
  /**
   * What the plugin returned last time for this Source to resume from, such as a sync token or
   * the last mail read; opaque to the Instance. Null on the first run.
   */
  syncCursor: string | null;
  /** The time of the run, as the Instance's clock tells it. */
  now: Date;
  /** The IANA time zone the Family lives in, for times a Source gives without one. */
  timeZone: string;
};

/** A subdivision of a Source a plugin reports, such as a mail folder, a chat or a child of a school account. */
export type SourceAttributeDeclaration = {
  /** Identifies it within its Source; stable, such as a folder's id or a chat's JID. */
  externalId: string;
  /** What the Admin area shows, where an Admin assigns Family Members to it. */
  name: string;
};

export type IngestResult = {
  /**
   * The Source Attributes the Source has now, which a plugin reports and nothing else creates.
   * Whom an Item concerns follows from the Source Attributes its Origin names, and the Family
   * Members an Admin assigned to them. The core applies them before it ingests `origins`, so an
   * Origin may name any id declared here. Idempotent: an id the Source knows already gets its new
   * name and is revived if it was archived, keeping its Family Members. A Source without
   * subdivisions declares exactly one. A run that fails applies none of them.
   */
  declaredAttributes?: SourceAttributeDeclaration[];
  /**
   * External ids of Source Attributes that are gone, such as a deleted folder. Applied after
   * `declaredAttributes`. Their assignment and the Items they decided stay; an Origin cannot name
   * one until it is declared again. An unknown id is ignored.
   */
  archivedAttributes?: string[];
  origins: Origin[];
  /** Where the next run resumes; stored only together with these Origins. */
  syncCursor: string | null;
  /**
   * External ids of Origins deleted in the Source since, such as redacted messages or calendar
   * entries that vanished; their Items are deleted. Ids the core never recorded are ignored.
   */
  withdrawn?: string[];
};

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

/** The kinds of Item a plugin states on its Origin, without the LLM. */
export const statedKinds = ["event", "lesson", "task"] as const;

/**
 * The longest text an Item of each kind keeps, such as a title or a room. A plugin clips its texts
 * to these with `clipped`; an Item with a longer one is not written.
 */
export const statedTextLimits = { event: 500, lesson: 200, task: 500 } as const;

/** The text, trimmed, and cut to at most `limit` characters. */
export function clipped(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit).trimEnd();
}

/**
 * When an Event takes place: between two ISO 8601 instants, or on whole days given as
 * `YYYY-MM-DD` in the Family's time zone, both days included.
 */
export type EventSpan =
  | { allDay: false; start: string; end: string }
  | { allDay: true; firstDay: string; lastDay: string };

/**
 * An Event as a calendar states it, whole. `cancelled` only when the Source says so, such as an
 * entry with `STATUS:CANCELLED`; an entry that is gone is withdrawn instead.
 */
export type StatedEvent = { kind: "event"; title: string; span: EventSpan; place: string | null; cancelled: boolean };

/** When a Lesson takes place, between two ISO 8601 instants; never all day. */
export type LessonSpan = { allDay: false; start: string; end: string };

/**
 * A Lesson as a timetable states it, whole: its subject, room and teacher as it takes place, and
 * how it deviates from the Timetable, if it does. `previousRoom`, `previousTeacher` and `note`, what
 * the school wrote about it, go only with a `change`.
 */
export type StatedLesson = {
  kind: "lesson";
  subject: string;
  span: LessonSpan;
  room: string | null;
  teacher: string | null;
  change: "cancellation" | "substitution" | "room-change" | null;
  previousRoom: string | null;
  previousTeacher: string | null;
  note: string | null;
};

/**
 * A Task as a Source states it, whole: something to do or bring, by a Deadline (`YYYY-MM-DD`) if it
 * has one. `bring` is a packing list, ticked with the Task and never entry by entry; each text is
 * at most `statedTextLimits.task` long, and there are at most 50. Whether it is done is the
 * Family's to say by ticking it: stating the Task again never changes that.
 */
export type StatedTask = { kind: "task"; title: string; deadline: string | null; bring: string[] };

/** The one Item an Origin of a calendar, a timetable or a list of Tasks states, as the Source has it now. */
export type StatedItem = StatedEvent | StatedLesson | StatedTask;

/** What a Source delivered under one external id: a message, or an entry stating its one Item. */
export type Origin = {
  /** Identifies the Origin within its Source, such as a message id or a calendar entry's UID. */
  externalId: string;
  /**
   * When the Source received it, such as the time a mailbox or a homeserver got a message. A
   * message needs it; a stated Item has none.
   */
  occurredAt?: Date;
  /**
   * The external ids of the Source Attributes it belongs to, such as the folder of a mail, each
   * declared before. Whom it concerns is decided by the Family Members assigned to
   * them. Naming one that is unknown or archived is a plugin bug: the Origin is refused. Emitted
   * again with another list, an Origin moves to it without being read again; with an empty list, it
   * is withdrawn like one named in `withdrawn`.
   */
  attributes: string[];
  /** Who sent a message, shown with it; the Family does not choose whom an Item concerns by it. */
  sender?: string;
  /** The subject of a message, shown with it. */
  subject?: string;
  /** An `http` or `https` address where the Family can look at the original, if there is one. */
  link?: string;
  content:
    | {
        /** A message to extract Items from, such as a mail. */
        kind: "raw-message";
        text: string;
        attachments: Attachment[];
      }
    | {
        /**
         * The Item as the Source has it now, which the core writes without the LLM. Every run
         * states every current entry again; one whose Item is unchanged costs nothing.
         */
        kind: "stated";
        stated: StatedItem;
      };
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

/**
 * Programs a plugin runs on the Instance for its Sources, such as a homeserver and the bridges of
 * the Messengers an Admin enabled. Only the worker runs them: it reconciles them with
 * what is enabled every few seconds, and stops them when it shuts down.
 */
export type Services = {
  /**
   * Starts what is enabled and stops the rest: `entries` are the ids of the catalogue's enabled
   * entries, and `enabled` is false once the Source Type is disabled. Returns quickly when nothing
   * changed; a service still starting is left to start, to be looked at again next time.
   */
  reconcile(enabled: { enabled: boolean; entries: string[] }): Promise<void>;
  /** Stops every service, as the worker shuts down. */
  stop(): Promise<void>;
};

export interface SourcePlugin {
  identity: SourcePluginIdentity;
  configuration: Configuration;
  setupSteps: SetupStep[];
  ingestion: Ingestion;
  health: Health;
  catalogue?: Catalogue;
  services?: Services;
  /**
   * Prepares a Source an Admin adds, such as by creating an account for it, and returns the
   * values of its fields set by the plugin. A `SourceError` refuses adding the Source.
   */
  sourceAdded?(context: Omit<RunContext, "syncCursor">): Promise<{ plain: JsonObject; secrets: Record<string, string> }>;
  /** Cleans up after a Source was removed, such as by logging its account out; a failure is ignored. */
  sourceRemoved?(context: RunContext): Promise<void>;
}

const sourceTypeIdPattern = /^[a-z][a-z0-9-]*$/;

/** Problems that keep a plugin from being loaded, such as an incompatible SDK version. */
export function problemsWith(plugin: SourcePlugin): string[] {
  const { identity, configuration, ingestion, catalogue } = plugin;
  const problems = problemsWithIdentity(identity);
  problems.push(...fieldProblems(configuration.fields));
  problems.push(...catalogueProblems(configuration.fields, catalogue));
  problems.push(...versionProblems(configuration.version, configuration.migrations));
  if (ingestion.mode === "polling" && ingestion.suggestedIntervalSeconds <= 0) {
    problems.push("the suggested polling interval must be positive");
  }
  return problems;
}

function versionProblems(version: number, migrations?: Record<number, (plain: JsonObject) => JsonObject>): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(version) || version < 1) {
    problems.push("the configuration version must be a whole number from 1");
  }
  for (let from = 1; from < version; from++) {
    if (!migrations?.[from]) problems.push(`no configuration migration from version ${from}`);
  }
  return problems;
}

function fieldProblems(fields: ConfigField[]): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const field of fields) {
    problems.push(...fieldProblemsOf(field, keys));
    keys.add(field.key);
  }
  return problems;
}

function fieldProblemsOf(field: ConfigField, keys: Set<string>): string[] {
  const problems: string[] = [];
  if (keys.has(field.key)) problems.push(`configuration field "${field.key}" is declared twice`);
  if (field.choices && field.secret) problems.push(`configuration field "${field.key}" is a choice, so it cannot be secret`);
  return problems;
}

function catalogueProblems(fields: ConfigField[], catalogue: Catalogue | undefined): string[] {
  if (!catalogue) return [];
  const field = fields.find((candidate) => candidate.key === catalogue.configKey);
  if (!field || field.secret || field.setByPlugin) {
    return [`the catalogue's field "${catalogue.configKey}" is no plain field an Admin sets`];
  }
  return [];
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
  problems.push(...contentProblems(origin));
  problems.push(...attributeProblems(origin.attributes));
  if (origin.link !== undefined && !/^https?:\/\//i.test(origin.link)) {
    problems.push("the Origin's link is no http or https address");
  }
  return problems;
}

function attributeProblems(attributes: string[]): string[] {
  const problems: string[] = [];
  if (attributes.includes("")) problems.push("the Origin names an empty Source Attribute id");
  const twice = attributes.filter((id, index) => id !== "" && attributes.indexOf(id) !== index);
  for (const id of new Set(twice)) problems.push(`the Origin names the Source Attribute "${id}" twice`);
  return problems;
}

function contentProblems(origin: Origin): string[] {
  const { content, occurredAt } = origin;
  if (content.kind === "stated") {
    const known = (statedKinds as readonly string[]).includes(content.stated.kind);
    return known ? [] : [`"${content.stated.kind}" is no kind of Item a Source states`];
  }
  return occurredAt && !Number.isNaN(occurredAt.getTime()) ? [] : ["the Origin has no valid time"];
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
  const raw = manifestRaw(packageJson);
  if (raw === null) return { ok: false, problem: "no-manifest" };

  const details: string[] = [];
  const text = (key: string, value: unknown): string => {
    if (typeof value === "string" && value.trim() !== "") return value;
    details.push(`${key} is missing`);
    return "";
  };
  /** A text the Admin area shows: plain, or per language with English. */
  // eslint-disable-next-line sonarjs/function-return-type -- intentionally returns different members of the PluginText union
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
  const version = manifestVersion(packageJson);
  needsLlmDetails(raw.needsLlm, details);
  const riskNotice = raw.riskNotice === undefined ? undefined : shown("riskNotice", raw.riskNotice);
  if (details.length > 0) {
    return { ok: false, problem: "invalid-manifest", ...(sourceTypeId ? { sourceTypeId } : {}), details };
  }
  return { ok: true, manifest: buildManifest(packageJson, raw, entry, sourceTypeId, displayName, sdk, description, version, riskNotice) };
}

function manifestRaw(packageJson: unknown): Record<string, unknown> | null {
  const pkg = isObject(packageJson) ? packageJson : {};
  const familyAgenda = isObject(pkg.familyAgenda) ? pkg.familyAgenda : {};
  const raw = familyAgenda.sourcePlugin;
  return isObject(raw) ? raw : null;
}

function manifestVersion(packageJson: unknown): string {
  const pkg = isObject(packageJson) ? packageJson : {};
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

function needsLlmDetails(value: unknown, details: string[]): void {
  if (value !== undefined && typeof value !== "boolean") details.push("needsLlm is not true or false");
}

function buildManifest(
  packageJson: unknown,
  raw: Record<string, unknown>,
  entry: string,
  sourceTypeId: string,
  displayName: PluginText,
  sdkVersion: string,
  description: PluginText,
  version: string,
  riskNotice: PluginText | undefined,
): SourcePluginManifest {
  const pkg = isObject(packageJson) ? packageJson : {};
  return {
    entry,
    identity: { sourceTypeId, displayName, version, sdkVersion },
    description,
    needsLlm: raw.needsLlm === true,
    esModule: pkg.type === "module" || /\.m[jt]s$/.test(entry),
    ...(riskNotice !== undefined ? { riskNotice } : {}),
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
