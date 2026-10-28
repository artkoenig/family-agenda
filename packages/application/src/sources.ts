import { randomUUID } from "node:crypto";
import { textIn, type MultilingualText, type SourceId, type SourceTypeId } from "@family-agenda/domain";
import type {
  BlobStore,
  CatalogueRepository,
  Clock,
  ConfigFieldSpec,
  FamilyRepository,
  KnownValue,
  LoadedSourceType,
  PlainConfig,
  SecretRef,
  SecretStore,
  SetupProgress,
  SetupStepSpec,
  Source,
  SourceRepository,
  SourceRunContext,
  SourceTypeRegistry,
  SourceTypeRepository,
} from "./ports";
import { usableEntries } from "./catalogues";
import { enabledSourceType } from "./enabled-source-type";
import { healthOf, type SourceHealth } from "./source-health";

export type SourcesDeps = {
  clock: Clock;
  families: FamilyRepository;
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
  health: SourceHealth;
  /** The values each choice field offers, such as the chats of a linked account, by field key. */
  choices: Record<string, KnownValue[]>;
};

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

/** How often an Admin may have a Source polled. */
export const pollIntervalRange = { minSeconds: 60, maxSeconds: 7 * 24 * 60 * 60 };

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
  const { clock, families, registry, sourceTypes, catalogues, sources, secrets, blobs, timeZone } = deps;

  const enabled = (sourceTypeId: SourceTypeId) => enabledSourceType(sourceTypeId, { registry, sourceTypes });

  const contextOf = (source: Source) => runContextOf(source, { secrets, now: clock.now(), timeZone });

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
    const interval = input.pollIntervalSeconds;
    if (
      interval != null &&
      !(Number.isInteger(interval) && interval >= pollIntervalRange.minSeconds && interval <= pollIntervalRange.maxSeconds)
    ) {
      return { ok: false, problem: "invalid-interval" };
    }
    const invalid = new Set<string>();
    const given = (key: string, secret: boolean) => {
      const value = secret ? input.secrets[key] : input.plain[key];
      return value !== undefined && value !== null && value !== "";
    };
    for (const field of sourceType.configuration.fields) {
      if (field.setByPlugin) {
        if (given(field.key, field.secret) || given(field.key, !field.secret)) invalid.add(field.key);
        continue;
      }
      const present = given(field.key, field.secret) || (field.secret && stored.includes(field.key));
      if (field.required && !present) invalid.add(field.key);
      if (given(field.key, !field.secret)) invalid.add(field.key);
      const value = input.plain[field.key];
      if (field.choice && value !== undefined && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
        invalid.add(field.key);
      }
      if (!field.choice && Array.isArray(value)) invalid.add(field.key);
    }
    const entryKey = sourceType.catalogue?.configKey;
    const entry = entryKey !== undefined ? input.plain[entryKey] : undefined;
    if (entryKey !== undefined && usable !== null && !(typeof entry === "string" && usable.includes(entry))) {
      invalid.add(entryKey);
    }
    const declared = new Set(sourceType.configuration.fields.map((field) => field.key));
    for (const key of [...Object.keys(input.plain), ...Object.keys(input.secrets)]) {
      if (!declared.has(key)) invalid.add(key);
    }
    return invalid.size > 0 ? { ok: false, problem: "invalid-config", fields: [...invalid].sort() } : null;
  }

  /** Plain values left empty are not stored; a choice with none chosen is. */
  function plainOf(input: SourceInput): PlainConfig {
    return Object.fromEntries(Object.entries(input.plain).filter(([, value]) => value !== "" && value != null));
  }

  /** The values each choice field of a Source offers; none while its Source Type is not enabled. */
  async function choicesOf(source: Source): Promise<Record<string, KnownValue[]>> {
    const sourceType = await enabled(source.sourceTypeId);
    const fields = sourceType?.configuration.fields.filter((field) => field.choice) ?? [];
    if (!sourceType || fields.length === 0) return {};
    const context = await contextOf(source);
    const choices: Record<string, KnownValue[]> = {};
    for (const field of fields) choices[field.key] = await sourceType.choices(field.key, context);
    return choices;
  }

  return {
    async list(): Promise<SourceSummary[]> {
      const installed = registry.installed();
      const all = await sources.list(await families.theFamily());
      const summaries: SourceSummary[] = [];
      for (const source of all) {
        summaries.push({
          id: source.id,
          sourceTypeId: source.sourceTypeId,
          displayName: installed.find((type) => type.id === source.sourceTypeId)?.displayName ?? source.sourceTypeId,
          plain: source.plain,
          storedSecrets: Object.keys(source.secrets).sort(),
          pollIntervalSeconds: source.pollIntervalSeconds,
          shown: source.shown,
          health: await healthOf(source, { clock, registry, sourceTypes, sources }),
          choices: await choicesOf(source),
        });
      }
      return summaries;
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
      const sourceTypeId = input.sourceTypeId as SourceTypeId;
      const sourceType = await enabled(sourceTypeId);
      if (!sourceType) return { ok: false, problem: "source-type-not-enabled" };
      const usable = sourceType.catalogue ? (await usableEntries(sourceTypeId, sourceType, catalogues)).map((entry) => entry.id) : null;
      const problem = check(sourceType, input, [], usable);
      if (problem) return problem;

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
        familyId: await families.theFamily(),
        sourceTypeId,
        plain: { ...given.plain, ...Object.fromEntries(ofPlugin(prepared.plain)) },
        configVersion: sourceType.configuration.version,
        secrets: refs,
        state: null,
        pollIntervalSeconds: input.pollIntervalSeconds ?? null,
        shown: true,
        lastRunAt: null,
        lastSuccessAt: null,
        failure: null,
        lastNewOriginAt: null,
        createdAt: clock.now(),
      });
      return { ok: true, id, setUp: sourceType.setupSteps.some((step) => step.live) };
    },

    /**
     * Changes a Source's configuration and polling interval, and runs it on the next tick, so
     * that a fix shows at once. Its state stays, so that a calendar whose address an Admin fixes
     * resumes where it was.
     */
    async edit(id: SourceId, input: SourceInput): Promise<EditSourceResult> {
      const source = await sources.findById(id);
      if (!source) return { ok: false, problem: "unknown-source" };
      const sourceType = await enabled(source.sourceTypeId);
      if (!sourceType) return { ok: false, problem: "source-type-not-enabled" };
      // What the plugin set, and the catalogue entry the Source was added with, stay.
      const kept = sourceType.configuration.fields
        .filter((field) => !field.secret && (field.setByPlugin || field.key === sourceType.catalogue?.configKey))
        .map((field) => field.key);
      const keptPlain = Object.fromEntries(kept.flatMap((key) => (source.plain[key] !== undefined ? [[key, source.plain[key]]] : [])));
      const entryKey = sourceType.catalogue?.configKey;
      const checked = entryKey !== undefined ? { ...input, plain: { ...input.plain, [entryKey]: source.plain[entryKey] } } : input;
      const problem = check(sourceType, checked, Object.keys(source.secrets));
      if (problem) return problem;

      const refs = { ...source.secrets };
      const replaced: SecretRef[] = [];
      for (const [key, value] of Object.entries(input.secrets)) {
        if (value === "") continue;
        const old = refs[key];
        if (old) replaced.push(old);
        refs[key] = await secrets.put(value);
      }
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
    },

    /**
     * Shows or hides the Source's Items on the timeline and in the feeds. A hidden Source is still
     * read, so that its Items are up to date once it is shown again.
     */
    async setShown(id: SourceId, shown: boolean): Promise<void> {
      await sources.setShown(id, shown);
    },

    /** Removes the Source with its secrets, its Attribution Rules and everything it brought in: Origins, messages, Revisions and Items. */
    async remove(id: SourceId): Promise<void> {
      const source = await sources.findById(id);
      if (!source) return;
      const sourceType = await enabled(source.sourceTypeId);
      const context = await contextOf(source);
      const files = await sources.remove(id);
      await sourceType?.sourceRemoved(context);
      for (const ref of Object.values(source.secrets)) await secrets.remove(ref);
      for (const file of files) await blobs.remove(file);
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
  return { plain: source.plain, secrets: secretValues, state: source.state, now: context.now, timeZone: context.timeZone };
}
