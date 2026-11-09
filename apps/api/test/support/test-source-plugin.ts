import { PluginError, type PluginImplementation } from "@family-agenda/plugin-kit";
import type { RunContext as ContractRunContext, SourceRecord } from "@family-agenda/plugin-contract";

export type PluginText = string | { en: string; [language: string]: string };
type JsonObject = Record<string, unknown>;

export type StatedEvent = {
  kind: "event";
  title: string;
  span: { allDay: false; start: string; end: string } | { allDay: true; firstDay: string; lastDay: string };
  place: string | null;
  cancelled: boolean;
};
export type StatedLesson = {
  kind: "lesson";
  subject: string;
  span: { allDay: false; start: string; end: string };
  room: string | null;
  teacher: string | null;
  change: "cancellation" | "substitution" | "room-change" | null;
  previousRoom: string | null;
  previousTeacher: string | null;
  note: string | null;
};
export type StatedTask = { kind: "task"; title: string; deadline: string | null; bring: string[] };

/** What a test plugin emits: a Source Record with a Date and bytes in place of their JSON forms. */
export type Origin = {
  externalId: string;
  occurredAt?: Date;
  attributes: string[];
  sender?: string;
  subject?: string;
  link?: string;
  content:
    | { kind: "raw-message"; text: string; attachments: { filename: string; contentType: string; bytes: Uint8Array }[] }
    | { kind: "stated"; stated: StatedEvent | StatedLesson | StatedTask };
};

export type SourceAttributeDeclaration = { externalId: string; name: string };
export type CatalogueEntry = { id: string; displayName: PluginText; description: PluginText; installed: boolean; riskNotice?: PluginText };
export type SetupProgress =
  | { status: "waiting"; qrCode?: string; message?: PluginText }
  | { status: "done"; message?: PluginText }
  | { status: "failed"; message: PluginText };
export type SetupStep = { id: string; title: PluginText; description: PluginText };

/** What a test plugin was run with, its time as a Date. */
export type RunContext = Omit<ContractRunContext, "now"> & { now: Date };

export type TestConfigField = {
  key: string;
  label: PluginText;
  secret: boolean;
  required: boolean;
  description?: PluginText;
  setByPlugin?: boolean;
  host?: boolean;
  /** Whether it offers the values `testPluginControls.knowValues` sets. */
  choices?: boolean;
};

export type TestConfiguration = {
  version: number;
  fields: TestConfigField[];
  /** Turns the plain configuration of a version into that of the next. */
  migrations?: Record<number, (plain: JsonObject) => JsonObject>;
};

const pending = new Map<string, { origins: Origin[]; failure?: PluginError; withdrawn?: string[] }>();
const runs = new Map<string, RunContext[]>();
const declaring = new Map<string, SourceAttributeDeclaration[]>();
const archiving = new Map<string, string[]>();
const undeclared = new Set<string>();
const knownValues = new Map<string, { value: string; label: string }[]>();
const choicesAsked = new Map<string, number>();
const catalogueEntries = new Map<string, CatalogueEntry[]>();
const setupProgress = new Map<string, SetupProgress>();
const addingFails = new Set<string>();
const addingHeld = new Map<string, Promise<void>>();
const askingFails = new Map<string, string>();
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
  /** Makes asking the plugin for choices and catalogue entries fail with this message from now on; null makes it answer again. */
  failAsking(sourceTypeId: string, message: string | null): void {
    if (message === null) askingFails.delete(sourceTypeId);
    else askingFails.set(sourceTypeId, message);
  },
  /** Makes preparing the next Source being added fail. */
  failAdding(sourceTypeId: string): void {
    addingFails.add(sourceTypeId);
  },
  /** Makes preparing the Sources being added wait until the returned function is called. */
  holdAdding(sourceTypeId: string): () => void {
    let release = () => {};
    addingHeld.set(sourceTypeId, new Promise((resolve) => (release = resolve)));
    return () => {
      addingHeld.delete(sourceTypeId);
      release();
    };
  },
  /** What the plugin was told of removed Sources, oldest first. */
  removed(sourceTypeId: string): RunContext[] {
    return removed.get(sourceTypeId) ?? [];
  },
  failNext(sourceTypeId: string, kind: "definite" | "temporary"): void {
    pending.set(sourceTypeId, { origins: [], failure: new PluginError(kind, `${sourceTypeId} failed`) });
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

export type TestPluginPackage = {
  sourceTypeId: string;
  displayName?: PluginText;
  version?: string;
  description?: PluginText;
  needsLlm?: boolean;
  riskNotice?: PluginText;
  configuration?: TestConfiguration;
  /** Whether its Sources count as Silent without new Origins; by default they do. */
  silentApplies?: boolean;
  setupSteps?: SetupStep[];
  /** A catalogue whose entries `testPluginControls.catalogue` sets; by default it has none. */
  catalogue?: { configKey: string };
  /** Setup steps driven live through `testPluginControls.setupShows`. */
  liveSteps?: string[];
};

const defaultConfiguration: TestConfiguration = {
  version: 1,
  fields: [
    { key: "url", label: "URL", secret: false, required: true },
    { key: "password", label: "Password", secret: true, required: false },
  ],
};

const contextOf = (context: ContractRunContext): RunContext => ({ ...context, now: new Date(context.now) });

/**
 * A polling plugin, served with plugin-kit, that emits the Origins it was given and fails on
 * demand. Fields set by the plugin get `<key>-<n>` when a Source is added, and a choice field
 * offers the values `knowValues` sets.
 */
export function testSourcePlugin(plugin: TestPluginPackage): PluginImplementation {
  const { sourceTypeId } = plugin;
  const configuration = plugin.configuration ?? defaultConfiguration;
  const fields = configuration.fields.map(({ choices, ...field }) => ({ ...field, hasChoices: choices === true }));
  const steps = [
    ...(plugin.setupSteps ?? []).map((step) => ({ ...step, live: false })),
    ...(plugin.liveSteps ?? []).map((id) => ({ id, title: id, description: `Go through ${id}.`, live: true })),
  ];
  return {
    description: {
      sourceTypeId,
      kind: "stateless",
      displayName: plugin.displayName ?? sourceTypeId,
      version: plugin.version ?? "1.0.0",
      description: plugin.description ?? `Reads ${sourceTypeId}.`,
      needsLlm: plugin.needsLlm ?? false,
      ...(plugin.riskNotice ? { riskNotice: plugin.riskNotice } : {}),
      configuration: { version: configuration.version, fields },
      setupSteps: steps,
      ingestion: { mode: "polling", suggestedIntervalSeconds: 600 },
      silentApplies: plugin.silentApplies ?? true,
      ...(plugin.catalogue ? { catalogue: { title: "Networks", configKey: plugin.catalogue.configKey } } : {}),
    },
    poll: (context) => {
      runs.set(sourceTypeId, [...(runs.get(sourceTypeId) ?? []), contextOf(context)]);
      const next = pending.get(sourceTypeId) ?? { origins: [] };
      pending.delete(sourceTypeId);
      if (next.failure) throw next.failure;
      return {
        sourceRecords: next.origins.map(sourceRecordOf),
        syncCursor: String(Number(context.syncCursor ?? 0) + 1),
        ...(next.withdrawn ? { withdrawn: next.withdrawn } : {}),
        attributes: attributesOf(sourceTypeId, next.origins),
      };
    },
    sourceAdded: async () => {
      await addingHeld.get(sourceTypeId);
      if (addingFails.delete(sourceTypeId)) throw new PluginError("temporary", "the homeserver is unreachable");
      accounts += 1;
      const plain: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      for (const field of fields.filter((candidate) => candidate.setByPlugin)) {
        (field.secret ? secrets : plain)[field.key] = `${field.key}-${accounts}`;
      }
      return { plain, secrets };
    },
    sourceRemoved: (context) => {
      removed.set(sourceTypeId, [...(removed.get(sourceTypeId) ?? []), contextOf(context)]);
    },
    fieldChoices: () => {
      choicesAsked.set(sourceTypeId, (choicesAsked.get(sourceTypeId) ?? 0) + 1);
      return { choices: askedOf(sourceTypeId, knownValues.get(sourceTypeId) ?? []) };
    },
    catalogueEntries: () => ({ entries: askedOf(sourceTypeId, catalogueEntries.get(sourceTypeId) ?? []) }),
    setupProgress: () => setupProgress.get(sourceTypeId) ?? { status: "waiting" },
    configMigration: ({ fromVersion, plain }) => {
      const migrate = configuration.migrations?.[fromVersion];
      if (!migrate) throw new PluginError("definite", `no migration from version ${fromVersion}`);
      return { plain: migrate(plain) };
    },
  };
}

function sourceRecordOf(origin: Origin): SourceRecord {
  const { occurredAt, content, ...rest } = origin;
  return {
    ...rest,
    ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}),
    content:
      content.kind === "raw-message"
        ? { ...content, attachments: content.attachments.map((attachment) => ({ ...attachment, bytes: Buffer.from(attachment.bytes).toString("base64") })) }
        : content,
  };
}

/** Declares the Source Attributes the Origins name and those asked for, then archives those asked for. */
function attributesOf(sourceTypeId: string, origins: Origin[]): { declared: SourceAttributeDeclaration[]; archived: string[] } {
  const named = new Map<string, string>();
  if (!undeclared.delete(sourceTypeId)) for (const id of origins.flatMap((origin) => origin.attributes)) named.set(id, id);
  for (const { externalId, name } of declaring.get(sourceTypeId) ?? []) named.set(externalId, name);
  declaring.delete(sourceTypeId);
  const archived = archiving.get(sourceTypeId) ?? [];
  archiving.delete(sourceTypeId);
  return { declared: [...named].map(([externalId, name]) => ({ externalId, name })), archived };
}

/** What the plugin answers when asked, or the failure set with `failAsking`. */
function askedOf<T>(sourceTypeId: string, answer: T): T {
  const failure = askingFails.get(sourceTypeId);
  if (failure !== undefined) throw new PluginError("temporary", failure);
  return answer;
}
