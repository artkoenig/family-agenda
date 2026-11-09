import { randomUUID } from "node:crypto";
import { parseName, textIn, type BlobRef, type FamilyMemberId, type MultilingualText, type SourceAttributeId, type SourceId, type SourceTypeId } from "@family-agenda/domain";
import type {
  BlobStore,
  CatalogueRepository,
  Clock,
  ConfigFieldSpec,
  FamilyMemberRepository,
  KnownValue,
  PluginAnswer,
  LoadedSourceType,
  PlainConfig,
  SecretRef,
  SecretStore,
  SetupProgress,
  SetupStepSpec,
  Source,
  SourceAttribute,
  SourceRepository,
  SourceRunContext,
  SourceTypeRegistry,
  SourceTypeRepository,
} from "./ports";
import { usableEntries } from "./catalogues";
import { enabledSourceType } from "./enabled-source-type";
import { isPollInterval } from "./poll-interval";
import { healthOf, type SourceHealth } from "./source-health";

export type SourcesDeps = {
  clock: Clock;
  members: FamilyMemberRepository;
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  catalogues: CatalogueRepository;
  sources: SourceRepository;
  secrets: SecretStore;
  blobs: BlobStore;
  /** The IANA time zone the Family lives in, for the plugin's runs. */
  timeZone: string;
};

export type SourceSummary = {
  id: SourceId;
  sourceTypeId: SourceTypeId;
  /** The Source Type's name, or its id if its plugin is no longer installed. */
  displayName: MultilingualText;
  plain: PlainConfig;
  /** The secret fields that have a value; the values never leave the SecretStore but to the plugin. */
  storedSecrets: string[];
  /** As an Admin set it; null for the plugin's suggestion. */
  pollIntervalSeconds: number | null;
  /** Whether its Items show on the timeline and in the feeds; a hidden Source is still read. */
  shown: boolean;
  /** As an Admin named it; null for the name the Admin area derives from its settings. */
  name: string | null;
  /** Its Source Attributes as its plugin reported them, each with the Family Members assigned to it. */
  attributes: SourceAttribute[];
  health: SourceHealth;
  /**
   * The values each choice field offers, such as the chats of a linked account, by field key. Only
   * `find` and `listOfType` have them: asking a plugin may reach a mailbox or a homeserver, which
   * the list of all Sources should not.
   */
  choices?: Record<string, PluginAnswer<KnownValue[]>>;
};

/** How long the values a plugin offers for a Source's choice fields are shown before it is asked again. */
const choicesMaxAgeMs = 5 * 60_000;

/** What the Admin area renders a Source's form from, for an enabled Source Type. */
export type SourceForm = {
  sourceTypeId: SourceTypeId;
  displayName: MultilingualText;
  /** The fields an Admin sets; those the plugin sets are left out. */
  fields: ConfigFieldSpec[];
  /**
   * The field naming the catalogue entry a Source uses, such as its Messenger, with the entries
   * that are enabled and installed; null if the Source Type has no catalogue.
   */
  catalogue: { configKey: string; entries: { id: string; displayName: MultilingualText }[] } | null;
  /** Interactive steps shown with the fields, when adding a Source and when fixing one. */
  setupSteps: SetupStepSpec[];
  /** Null if its Sources are not polled. */
  suggestedIntervalSeconds: number | null;
};

export type SourceInput = {
  plain: PlainConfig;
  /** A secret left empty keeps the stored one when editing. */
  secrets: Record<string, string>;
  /** Null or left out for the plugin's suggestion. */
  pollIntervalSeconds?: number | null;
};

export type SourceProblem =
  | { ok: false; problem: "invalid-interval" }
  /** `fields` are the keys that are missing, unknown, or given as plain instead of secret. */
  | { ok: false; problem: "invalid-config"; fields: string[] };

/** Identifies a Source being added in the background. */
export type AddingId = string & { readonly __brand: "AddingId" };

/** Added already, as `add` answers, or still being prepared in the background. */
export type StartAddingResult = AddSourceResult | { ok: true; adding: AddingId };

/** How a Source added in the background is coming along. */
export type AddingProgress =
  | { status: "running"; sourceTypeId: string; plain: PlainConfig }
  | { status: "added"; sourceTypeId: string; id: SourceId; setUp: boolean }
  /** Its plugin could not prepare it; what was entered, without secrets, for the form to show again. */
  | { status: "failed"; sourceTypeId: string; message: string; plain: PlainConfig; pollIntervalSeconds: number | null };

/** How long adding a Source waits for its plugin before leaving it to the background. */
const addingWaitMs = 1000;

/** Resolves to undefined after `ms`, for a race against a slower answer. */
const delay = (ms: number) => new Promise<undefined>((resolve) => setTimeout(() => { resolve(undefined); }, ms).unref());

/** How long an adding that ended is remembered. */
const addingsKeptMs = 10 * 60_000;

function failedAdding(input: SourceInput & { sourceTypeId: string }, message: string): AddingProgress {
  return { status: "failed", sourceTypeId: input.sourceTypeId, message, plain: input.plain, pollIntervalSeconds: input.pollIntervalSeconds ?? null };
}

function addingProgressOf(input: SourceInput & { sourceTypeId: string }, result: AddSourceResult): AddingProgress {
  if (result.ok) return { status: "added", sourceTypeId: input.sourceTypeId, id: result.id, setUp: result.setUp };
  return failedAdding(input, "message" in result ? result.message : result.problem);
}

export type AddSourceResult =
  /** `setUp` when it has live setup steps an Admin goes through next, such as a QR code login. */
  | { ok: true; id: SourceId; setUp: boolean }
  | { ok: false; problem: "source-type-not-enabled" }
  /** The plugin could not prepare the Source, such as when its homeserver is unreachable. */
  | { ok: false; problem: "setup-failed"; message: string }
  | SourceProblem;

export type EditSourceResult =
  | { ok: true }
  | { ok: false; problem: "unknown-source" | "source-type-not-enabled" }
  | SourceProblem;

export function createSourceAccess(deps: SourcesDeps) {
  const { clock, members, registry, sourceTypes, catalogues, sources, secrets, blobs, timeZone } = deps;

  const enabled = (sourceTypeId: SourceTypeId) => enabledSourceType(sourceTypeId, { registry, sourceTypes });

  const contextOf = (source: Source) => runContextOf(source, { secrets, now: clock.now(), timeZone });

  async function cleanup(source: Source, sourceType: LoadedSourceType | null, context: SourceRunContext, files: BlobRef[]): Promise<void> {
    await sourceType?.sourceRemoved(context);
    for (const ref of Object.values(source.secrets)) await secrets.remove(ref);
    for (const file of files) await blobs.remove(file);
  }

  /**
   * Why the input does not fit the plugin's configuration; `stored` secrets count as given. A new
   * Source's catalogue entry has to be one of the `usable` ones.
   */
  function check(
    sourceType: LoadedSourceType,
    input: SourceInput,
    stored: string[] = [],
    usable: string[] | null = null,
  ): SourceProblem | null {
    if (!isPollInterval(input.pollIntervalSeconds)) return { ok: false, problem: "invalid-interval" };
    const invalid = new Set<string>();
    for (const key of fieldProblems(sourceType, input, stored)) invalid.add(key);
    const entry = catalogueEntry(sourceType, input, usable);
    if (entry) invalid.add(entry);
    for (const key of unknownKeys(sourceType, input)) invalid.add(key);
    return invalid.size > 0 ? { ok: false, problem: "invalid-config", fields: [...invalid].sort() } : null;
  }

  /** The catalogue entry key is invalid when it names an entry the catalogue does not offer. */
  function catalogueEntry(
    sourceType: LoadedSourceType,
    input: SourceInput,
    usable: string[] | null,
  ): string | null {
    const key = sourceType.catalogue?.configKey;
    if (key === undefined || usable === null) return null;
    const entry = input.plain[key];
    return typeof entry === "string" && usable.includes(entry) ? null : key;
  }

  function unknownKeys(sourceType: LoadedSourceType, input: SourceInput): string[] {
    const declared = new Set(sourceType.configuration.fields.map((field) => field.key));
    const keys: string[] = [];
    for (const key of [...Object.keys(input.plain), ...Object.keys(input.secrets)]) {
      if (!declared.has(key)) keys.push(key);
    }
    return keys;
  }

  /** The keys a Source input gets wrong, by the Source Type's field declarations. */
  function* fieldProblems(sourceType: LoadedSourceType, input: SourceInput, stored: string[]): Generator<string> {
    const given = (key: string, secret: boolean) => {
      const value = secret ? input.secrets[key] : input.plain[key];
      return value !== undefined && value !== null && value !== "";
    };
    for (const field of sourceType.configuration.fields) {
      yield* problemsFor(field, given, input.plain[field.key], stored);
    }
  }

  function* problemsFor(
    field: ConfigFieldSpec,
    given: (key: string, secret: boolean) => boolean,
    value: unknown,
    stored: string[],
  ): Generator<string> {
    if (field.setByPlugin) {
      yield* pluginProblems(field, given);
      return;
    }
    yield* presenceProblems(field, given, stored);
    yield* typeProblems(field, value);
  }

  function* pluginProblems(field: ConfigFieldSpec, given: (key: string, secret: boolean) => boolean): Generator<string> {
    if (given(field.key, field.secret) || given(field.key, !field.secret)) yield field.key;
  }

  function* presenceProblems(field: ConfigFieldSpec, given: (key: string, secret: boolean) => boolean, stored: string[]): Generator<string> {
    const present = given(field.key, field.secret) || (field.secret && stored.includes(field.key));
    if (field.required && !present) yield field.key;
    if (given(field.key, !field.secret)) yield field.key;
  }

  function* typeProblems(field: ConfigFieldSpec, value: unknown): Generator<string> {
    if (!typeFits(field, value)) yield field.key;
  }

  /** Plain values left empty are not stored; a choice with none chosen is. */
  function plainOf(input: SourceInput): PlainConfig {
    return Object.fromEntries(Object.entries(input.plain).filter(([, value]) => value !== "" && value != null));
  }

  /** What the plugin set, and the catalogue entry the Source was added with, stay. */
  function keptPlainOf(source: Source, sourceType: LoadedSourceType): PlainConfig {
    const kept = sourceType.configuration.fields
      .filter((field) => !field.secret && (field.setByPlugin || field.key === sourceType.catalogue?.configKey))
      .map((field) => field.key);
    return Object.fromEntries(kept.flatMap((key) => (source.plain[key] !== undefined ? [[key, source.plain[key]]] : [])));
  }

  async function updateSecrets(current: Record<string, SecretRef>, input: Record<string, string>): Promise<{ refs: Record<string, SecretRef>; replaced: SecretRef[] }> {
    const refs = { ...current };
    const replaced: SecretRef[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (value === "") continue;
      const old = refs[key];
      if (old) replaced.push(old);
      refs[key] = await secrets.put(value);
    }
    return { refs, replaced };
  }


  async function summaryOf(source: Source): Promise<SourceSummary> {
    const installed = registry.installed();
    return {
      id: source.id,
      sourceTypeId: source.sourceTypeId,
      displayName: installed.find((type) => type.id === source.sourceTypeId)?.displayName ?? source.sourceTypeId,
      plain: source.plain,
      storedSecrets: Object.keys(source.secrets).sort(),
      pollIntervalSeconds: source.pollIntervalSeconds,
      shown: source.shown,
      name: source.name,
      attributes: source.attributes,
      health: await healthOf(source, { clock, registry, sourceTypes, sources }),
    };
  }

  /**
   * The choices plugins offered lately, by Source and configuration, so that a page showing a Source
   * does not ask its plugin again each time, such as an IMAP plugin logging in to list folders.
   */
  const offered = new Map<SourceId, { key: string; at: number; choices: Record<string, PluginAnswer<KnownValue[]>> }>();

  /** The values each choice field of a Source offers, as its plugin offered them lately. */
  async function choicesOf(source: Source): Promise<Record<string, PluginAnswer<KnownValue[]>>> {
    const key = JSON.stringify([source.sourceTypeId, source.configVersion, source.plain, source.secrets]);
    const now = clock.now().getTime();
    const last = offered.get(source.id);
    if (last && last.key === key && now - last.at < choicesMaxAgeMs) return last.choices;
    const choices = await askChoicesOf(source);
    if (Object.values(choices).every((answer) => answer.ok)) offered.set(source.id, { key, at: now, choices });
    else offered.delete(source.id);
    return choices;
  }

  /** The values each choice field of a Source offers; none while its Source Type is not enabled. */
  async function askChoicesOf(source: Source): Promise<Record<string, PluginAnswer<KnownValue[]>>> {
    const sourceType = await enabled(source.sourceTypeId);
    const fields = sourceType?.configuration.fields.filter((field) => field.choice) ?? [];
    if (!sourceType || fields.length === 0) return {};
    const context = await contextOf(source);
    const choices: Record<string, PluginAnswer<KnownValue[]>> = {};
    for (const field of fields) choices[field.key] = await sourceType.choices(field.key, context);
    return choices;
  }

  async function applyEdit(source: Source, sourceType: LoadedSourceType, input: SourceInput): Promise<EditSourceResult> {
    const keptPlain = keptPlainOf(source, sourceType);
    const entryKey = sourceType.catalogue?.configKey;
    const checked = entryKey !== undefined ? { ...input, plain: { ...input.plain, [entryKey]: source.plain[entryKey] } } : input;
    const problem = check(sourceType, checked, Object.keys(source.secrets));
    if (problem) return problem;

    const { refs, replaced } = await updateSecrets(source.secrets, input.secrets);
    await sources.update({
      ...source,
      plain: { ...plainOf(input), ...keptPlain },
      configVersion: sourceType.configuration.version,
      secrets: refs,
      pollIntervalSeconds: input.pollIntervalSeconds ?? null,
      lastRunAt: null,
    });
    for (const ref of replaced) await secrets.remove(ref);
    return { ok: true };
  }


  /** The enabled Source Type of a Source to add, or why its form cannot be saved. */
  async function checkedAdding(
    input: SourceInput & { sourceTypeId: string },
  ): Promise<{ sourceType: LoadedSourceType } | Exclude<AddSourceResult, { ok: true }>> {
    const sourceTypeId = input.sourceTypeId as SourceTypeId;
    const sourceType = await enabled(sourceTypeId);
    if (!sourceType) return { ok: false, problem: "source-type-not-enabled" };
    const usable = sourceType.catalogue ? (await usableEntries(sourceTypeId, sourceType, catalogues)).map((entry) => entry.id) : null;
    return check(sourceType, input, [], usable) ?? { sourceType };
  }

  /** Has the plugin prepare a checked Source, then stores it. */
  async function completeAdding(input: SourceInput & { sourceTypeId: string }, sourceType: LoadedSourceType): Promise<AddSourceResult> {
    const sourceTypeId = input.sourceTypeId as SourceTypeId;
    const given = { plain: plainOf(input), secrets: Object.fromEntries(Object.entries(input.secrets).filter(([, value]) => value !== "")) };
    const prepared = await sourceType.sourceAdded({ ...given, now: clock.now(), timeZone });
    if (!prepared.ok) return { ok: false, problem: "setup-failed", message: prepared.message };
    const setByPlugin = new Set(sourceType.configuration.fields.filter((field) => field.setByPlugin).map((field) => field.key));
    const ofPlugin = (values: Record<string, unknown>) => Object.entries(values).filter(([key]) => setByPlugin.has(key));

    const refs: Record<string, SecretRef> = {};
    for (const [key, value] of [...Object.entries(given.secrets), ...ofPlugin(prepared.secrets)]) {
      refs[key] = await secrets.put(String(value));
    }
    const id = randomUUID() as SourceId;
    await sources.add({
      id,
      sourceTypeId,
      plain: { ...given.plain, ...Object.fromEntries(ofPlugin(prepared.plain)) },
      configVersion: sourceType.configuration.version,
      secrets: refs,
      syncCursor: null,
      pollIntervalSeconds: input.pollIntervalSeconds ?? null,
      shown: true,
      name: null,
      attributes: [],
      lastRunAt: null,
      lastSuccessAt: null,
      failure: null,
      lastNewRecordAt: null,
      invalidRecords: [],
      unknownAttributes: [],
      createdAt: clock.now(),
    });
    return { ok: true, id, setUp: sourceType.setupSteps.some((step) => step.live) };
  }

  /** The Sources added in the background, by the id their adding was started with. */
  const addings = new Map<AddingId, { startedAt: number; progress: AddingProgress }>();

  /** Forgets addings that ended long ago, so that the map does not grow. */
  function pruneAddings() {
    const now = clock.now().getTime();
    for (const [id, { startedAt, progress }] of addings) {
      if (progress.status !== "running" && now - startedAt > addingsKeptMs) addings.delete(id);
    }
  }

  return {
    async list(): Promise<SourceSummary[]> {
      const all = await sources.list();
      const summaries: SourceSummary[] = [];
      for (const source of all) summaries.push(await summaryOf(source));
      return summaries;
    },

    /**
     * The Sources of one Source Type, each with the values its choice fields offer, so that the
     * Source Type's page can name what an Admin chose, such as a chat, instead of its id.
     */
    async listOfType(sourceTypeId: string): Promise<SourceSummary[]> {
      const ofType = (await sources.list()).filter((source) => source.sourceTypeId === sourceTypeId);
      const summaries: SourceSummary[] = [];
      for (const source of ofType) summaries.push({ ...(await summaryOf(source)), choices: await choicesOf(source) });
      return summaries;
    },

    /** A Source with the values its choice fields offer, as its own page shows them; null if there is none. */
    async find(id: SourceId): Promise<SourceSummary | null> {
      const source = await sources.findById(id);
      return source && { ...(await summaryOf(source)), choices: await choicesOf(source) };
    },

    /**
     * What a live setup step of a Source shows now, such as the QR code to scan; null if the
     * Source or the step is unknown, or its Source Type is not enabled.
     */
    async setupProgress(id: SourceId, stepId: string): Promise<SetupProgress | null> {
      const source = await sources.findById(id);
      const sourceType = source ? await enabled(source.sourceTypeId) : null;
      if (!source || !sourceType?.setupSteps.some((step) => step.id === stepId && step.live)) return null;
      return sourceType.setupProgress(stepId, await contextOf(source));
    },

    /** The forms of the enabled Source Types, for adding and editing their Sources. */
    async forms(): Promise<SourceForm[]> {
      const forms: SourceForm[] = [];
      for (const type of registry.installed()) {
        const sourceType = await enabled(type.id);
        if (!sourceType) continue;
        const { ingestion } = sourceType;
        const { catalogue } = sourceType;
        forms.push({
          sourceTypeId: type.id,
          displayName: type.displayName,
          fields: sourceType.configuration.fields.filter((field) => !field.setByPlugin),
          catalogue: catalogue
            ? {
                configKey: catalogue.configKey,
                entries: (await usableEntries(type.id, sourceType, catalogues)).map(({ id, displayName }) => ({ id, displayName })),
              }
            : null,
          setupSteps: sourceType.setupSteps,
          suggestedIntervalSeconds: ingestion.mode === "polling" ? ingestion.suggestedIntervalSeconds : null,
        });
      }
      return forms.sort((a, b) => textIn(a.displayName, "en").localeCompare(textIn(b.displayName, "en")));
    },

    /** Adds a Source of an enabled Source Type, configured by the fields its plugin declares. */
    async add(input: SourceInput & { sourceTypeId: string }): Promise<AddSourceResult> {
      const checked = await checkedAdding(input);
      return "problem" in checked ? checked : completeAdding(input, checked.sourceType);
    },

    /**
     * Adds a Source like `add`, but answers once its form is checked: its plugin prepares it in
     * the background, such as an IMAP plugin logging in, which `adding` tells about meanwhile.
     */
    async startAdding(input: SourceInput & { sourceTypeId: string }, waitMs = addingWaitMs): Promise<StartAddingResult> {
      const checked = await checkedAdding(input);
      if ("problem" in checked) return checked;
      const completing = completeAdding(input, checked.sourceType);
      // Most plugins prepare a Source at once; only one that takes longer is left to the background.
      const quick = await Promise.race([completing, delay(waitMs)]);
      if (quick) return quick;
      pruneAddings();
      const id = randomUUID() as AddingId;
      const startedAt = clock.now().getTime();
      addings.set(id, { startedAt, progress: { status: "running", sourceTypeId: input.sourceTypeId, plain: input.plain } });
      completing.then(
        (result) => addings.set(id, { startedAt, progress: addingProgressOf(input, result) }),
        (error: unknown) => addings.set(id, { startedAt, progress: failedAdding(input, error instanceof Error ? error.message : String(error)) }),
      );
      return { ok: true, adding: id };
    },

    /** How a Source added in the background is coming along; null for one not known (any more). */
    adding(id: AddingId): AddingProgress | null {
      return addings.get(id)?.progress ?? null;
    },

    /** The Sources of a Source Type still being prepared in the background, or whose preparing failed, oldest first. */
    addingsOf(sourceTypeId: string): { id: AddingId; progress: Exclude<AddingProgress, { status: "added" }> }[] {
      const listed: { id: AddingId; progress: Exclude<AddingProgress, { status: "added" }> }[] = [];
      for (const [id, { progress }] of addings) {
        if (progress.sourceTypeId === sourceTypeId && progress.status !== "added") listed.push({ id, progress });
      }
      return listed;
    },

    /** Forgets a Source added in the background, such as one whose failure an Admin saw. */
    forgetAdding(id: AddingId): void {
      addings.delete(id);
    },

    /**
     * Changes a Source's configuration and polling interval, and runs it on the next tick, so
     * that a fix shows at once. Its sync cursor stays, so that a calendar whose address an Admin fixes
     * resumes where it was.
     */
    async edit(id: SourceId, input: SourceInput): Promise<EditSourceResult> {
      const source = await sources.findById(id);
      if (!source) return { ok: false, problem: "unknown-source" };
      const sourceType = await enabled(source.sourceTypeId);
      if (!sourceType) return { ok: false, problem: "source-type-not-enabled" };
      return applyEdit(source, sourceType, input);
    },



    /**
     * Shows or hides the Source's Items on the timeline and in the feeds. A hidden Source is still
     * read, so that its Items are up to date once it is shown again.
     */
    async setShown(id: SourceId, shown: boolean): Promise<void> {
      await sources.setShown(id, shown);
    },

    /**
     * Names the Source as an Admin calls it, such as after the chats of a Messenger account. An
     * empty name brings back the one derived from its settings. It is as long as a Family Member's
     * name can be.
     */
    async rename(id: SourceId, name: string): Promise<{ ok: true } | { ok: false; problem: "invalid-name" }> {
      if (name.trim() === "") {
        await sources.rename(id, null);
        return { ok: true };
      }
      const parsed = parseName(name);
      if (parsed === null) return { ok: false, problem: "invalid-name" };
      await sources.rename(id, parsed);
      return { ok: true };
    },

    /**
     * Assigns a Source Attribute to Family Members, whom the Items of its Source Records then
     * concern, also those that came before; none for the whole Family. Nothing within a Source
     * Record, such as a sender, counts.
     */
    async assignAttribute(
      id: SourceAttributeId,
      concerns: FamilyMemberId[],
    ): Promise<{ ok: true } | { ok: false; problem: "unknown-attribute" | "unknown-member" }> {
      const family = await members.list();
      if (concerns.some((member) => !family.some((known) => known.id === member))) return { ok: false, problem: "unknown-member" };
      const found = await sources.assignAttribute(
        id,
        family.filter((member) => concerns.includes(member.id)).map((member) => member.id),
      );
      return found ? { ok: true } : { ok: false, problem: "unknown-attribute" };
    },

    /** Removes the Source with its secrets, its Source Attributes and everything it brought in: its Source Records and their Items. */
    async remove(id: SourceId): Promise<void> {
      const source = await sources.findById(id);
      if (!source) return;
      const sourceType = await enabled(source.sourceTypeId);
      const context = await contextOf(source);
      const files = await sources.remove(id);
      await cleanup(source, sourceType, context, files);
    },
  };
}

export type SourceAccess = ReturnType<typeof createSourceAccess>;

/** What a plugin is given to run for a Source: its configuration, with the values of its secrets. */
export async function runContextOf(
  source: Source,
  context: { secrets: SecretStore; now: Date; timeZone: string },
): Promise<SourceRunContext> {
  const secretValues: Record<string, string> = {};
  for (const [key, ref] of Object.entries(source.secrets)) {
    const value = await context.secrets.get(ref);
    if (value !== null) secretValues[key] = value;
  }
  return { plain: source.plain, secrets: secretValues, syncCursor: source.syncCursor, now: context.now, timeZone: context.timeZone };
}

/** Whether a value has the shape its field takes: names for a choice, a single value otherwise. */
function typeFits(field: ConfigFieldSpec, value: unknown): boolean {
  if (field.choice) return value === undefined || isStrings(value);
  return !Array.isArray(value);
}

function isStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
