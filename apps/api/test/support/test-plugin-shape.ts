import {
  sdkVersion,
  SourceError,
  type CatalogueEntry,
  type Configuration,
  type IngestResult,
  type RunContext,
  type SetupProgress,
  type SetupStep,
  type SourcePlugin,
} from "@family-agenda/source-sdk";

/*
 * The shape of the test plugin, without its state: whatever it does it asks of the test through
 * `ask`. Plugin Host processes share no memory with the test, so this module is what they run,
 * bundled with nothing but the SDK, asking over HTTP; tests that call a plugin directly ask in
 * process.
 */

export type TestPluginOptions = {
  sourceTypeId: string;
  configuration?: Configuration;
  /** Whether its Sources count as Silent without new Origins; by default they do. */
  silentApplies?: boolean;
  setupSteps?: SetupStep[];
  /** A catalogue whose entries `testPluginControls.catalogue` sets; by default it has none. */
  catalogue?: { configKey: string };
  /** Setup steps driven live through `testPluginControls.setupShows`. */
  liveSteps?: string[];
};

/** What the plugin asks of the test, with what it passes and what it gets back. */
export type Questions = {
  poll: { args: RunContext; answer: IngestResult | { sourceError: "definite" | "temporary"; message: string } };
  choices: { args: null; answer: { value: string; label: string }[] };
  setupProgress: { args: null; answer: SetupProgress };
  catalogueEntries: { args: null; answer: CatalogueEntry[] };
  sourceAdded: { args: { key: string; secret: boolean }[]; answer: { plain: Record<string, string>; secrets: Record<string, string> } | { sourceError: "temporary"; message: string } };
  sourceRemoved: { args: RunContext; answer: null };
};

export type Ask = <Q extends keyof Questions>(question: Q, sourceTypeId: string, args: Questions[Q]["args"]) => Promise<Questions[Q]["answer"]>;

/**
 * A polling plugin that emits the Origins it was given and fails on demand. Fields set by the
 * plugin get `account-<n>` when a Source is added, and a choice field offers the values its
 * `sender` attribute knows.
 */
export function testPluginWith(options: TestPluginOptions, ask: Ask): SourcePlugin {
  const { sourceTypeId } = options;
  const configuration = options.configuration ?? {
    version: 1,
    fields: [
      { key: "url", label: "URL", secret: false, required: true },
      { key: "password", label: "Password", secret: true, required: false },
    ],
  };
  const fields = configuration.fields.map((field) => (field.choices ? { ...field, choices: () => ask("choices", sourceTypeId, null) } : field));
  const live = (options.liveSteps ?? []).map((id) => ({
    id,
    title: id,
    description: `Go through ${id}.`,
    progress: () => ask("setupProgress", sourceTypeId, null),
  }));
  return {
    identity: { sourceTypeId, displayName: sourceTypeId, version: "1.0.0", sdkVersion },
    configuration: { ...configuration, fields },
    setupSteps: [...(options.setupSteps ?? []), ...live],
    ingestion: {
      mode: "polling",
      suggestedIntervalSeconds: 600,
      poll: async (context) => {
        const answer = await ask("poll", sourceTypeId, context);
        if ("sourceError" in answer) throw new SourceError(answer.message, answer.sourceError);
        return answer;
      },
    },
    health: { silentApplies: options.silentApplies ?? true },
    ...(options.catalogue
      ? { catalogue: { title: "Networks", configKey: options.catalogue.configKey, entries: () => ask("catalogueEntries", sourceTypeId, null) } }
      : {}),
    sourceAdded: async () => {
      const answer = await ask("sourceAdded", sourceTypeId, fields.filter((field) => field.setByPlugin).map(({ key, secret }) => ({ key, secret })));
      if ("sourceError" in answer) throw SourceError.temporary(answer.message);
      return answer;
    },
    sourceRemoved: async (context) => {
      await ask("sourceRemoved", sourceTypeId, context);
    },
  };
}
