import { randomUUID } from "node:crypto";
import { textIn, type MultilingualText, type SourceId, type SourceTypeId } from "@family-agenda/domain";
import type {
  BlobStore,
  Clock,
  ConfigFieldSpec,
  FamilyRepository,
  LoadedSourceType,
  PlainConfig,
  SecretRef,
  SecretStore,
  SetupStepSpec,
  Source,
  SourceRepository,
  SourceRunContext,
  SourceTypeRegistry,
  SourceTypeRepository,
} from "./ports";
import { enabledSourceType } from "./enabled-source-type";
import { healthOf, type SourceHealth } from "./source-health";

export type SourcesDeps = {
  clock: Clock;
  families: FamilyRepository;
  registry: SourceTypeRegistry;
  sourceTypes: SourceTypeRepository;
  sources: SourceRepository;
  secrets: SecretStore;
  blobs: BlobStore;
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
};

/** What the Admin area renders a Source's form from, for an enabled Source Type. */
export type SourceForm = {
  sourceTypeId: SourceTypeId;
  displayName: MultilingualText;
  fields: ConfigFieldSpec[];
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
  | { ok: true; id: SourceId }
  | { ok: false; problem: "source-type-not-enabled" }
  | SourceProblem;

export type EditSourceResult =
  | { ok: true }
  | { ok: false; problem: "unknown-source" | "source-type-not-enabled" }
  | SourceProblem;

export function createSourceAccess(deps: SourcesDeps) {
  const { clock, families, registry, sourceTypes, sources, secrets, blobs } = deps;

  const enabled = (sourceTypeId: SourceTypeId) => enabledSourceType(sourceTypeId, { registry, sourceTypes });

  /** Why the input does not fit the plugin's configuration; `stored` secrets count as given. */
  function check(sourceType: LoadedSourceType, input: SourceInput, stored: string[] = []): SourceProblem | null {
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
      const present = given(field.key, field.secret) || (field.secret && stored.includes(field.key));
      if (field.required && !present) invalid.add(field.key);
      if (given(field.key, !field.secret)) invalid.add(field.key);
    }
    const declared = new Set(sourceType.configuration.fields.map((field) => field.key));
    for (const key of [...Object.keys(input.plain), ...Object.keys(input.secrets)]) {
      if (!declared.has(key)) invalid.add(key);
    }
    return invalid.size > 0 ? { ok: false, problem: "invalid-config", fields: [...invalid].sort() } : null;
  }

  /** Plain values left empty are not stored. */
  function plainOf(input: SourceInput): PlainConfig {
    return Object.fromEntries(Object.entries(input.plain).filter(([, value]) => value !== "" && value != null));
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
        });
      }
      return summaries;
    },

    /** The forms of the enabled Source Types, for adding and editing their Sources. */
    async forms(): Promise<SourceForm[]> {
      const forms: SourceForm[] = [];
      for (const type of registry.installed()) {
        const sourceType = await enabled(type.id);
        if (!sourceType) continue;
        const { ingestion } = sourceType;
        forms.push({
          sourceTypeId: type.id,
          displayName: type.displayName,
          fields: sourceType.configuration.fields,
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
      const problem = check(sourceType, input);
      if (problem) return problem;

      const refs: Record<string, SecretRef> = {};
      for (const [key, value] of Object.entries(input.secrets)) {
        if (value !== "") refs[key] = await secrets.put(value);
      }
      const id = randomUUID() as SourceId;
      await sources.add({
        id,
        familyId: await families.theFamily(),
        sourceTypeId,
        plain: plainOf(input),
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
      return { ok: true, id };
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
      const problem = check(sourceType, input, Object.keys(source.secrets));
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
        plain: plainOf(input),
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
      const files = await sources.remove(id);
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
