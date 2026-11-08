import type {
  DeclaredAttribute,
  InstalledSourceType,
  LoadedSourceType,
  PlainConfig,
  SourceRunContext,
  SourceRunResult,
  SourceTypeRegistry,
} from "@family-agenda/application";
import type { SourceTypeId } from "@family-agenda/domain";
import { PluginHostClient, type HostedPlugin, type PluginHostConfig } from "./plugin-host-client";
import {
  problemsWith,
  problemsWithManifest,
  problemsWithOrigin,
  SourceError,
  type IngestResult,
  type JsonObject,
  type SetupProgress,
  type SourceAttributeDeclaration,
  type SourcePlugin,
  type SourcePluginManifest,
} from "@family-agenda/source-sdk";

type Offered = { installed: InstalledSourceType; hosted: HostedPlugin };

/**
 * The Source Types the Plugin Host offers, as it listed them at startup. A plugin's calls go to
 * the host; nothing of a plugin runs in this process.
 */
export class SourceRegistry implements SourceTypeRegistry {
  private readonly loaded = new Map<string, LoadedSourceType>();
  private readonly loadFailures = new Map<string, string>();

  private constructor(private readonly offered: Map<string, Offered>) {}

  /** Asks the Plugin Host for its plugins, `hostAttempts` times while it is still starting. */
  static async fromPluginHost(pluginHost: PluginHostConfig, options: { hostAttempts?: number } = {}): Promise<SourceRegistry> {
    const offered = new Map<string, Offered>();
    for (const { manifest, hosted } of await new PluginHostClient(pluginHost).available({ attempts: options.hostAttempts })) {
      offered.set(manifest.identity.sourceTypeId, { installed: installedOf(manifest), hosted });
    }
    return new SourceRegistry(offered);
  }

  installed(): InstalledSourceType[] {
    return [...this.offered.values()].map(({ installed }) => {
      const failure = this.loadFailures.get(installed.id);
      return failure ? { ...installed, notLoadable: failure } : installed;
    });
  }

  load(id: SourceTypeId): Promise<{ ok: true; sourceType: LoadedSourceType } | { ok: false }> {
    const plugin = this.pluginOf(id)?.plugin;
    if (!plugin) return Promise.resolve({ ok: false });
    let sourceType = this.loaded.get(id);
    if (!sourceType) {
      sourceType = loadedSourceType(plugin);
      this.loaded.set(id, sourceType);
    }
    return Promise.resolve({ ok: true, sourceType });
  }

  async migrateConfig(
    id: SourceTypeId,
    plain: PlainConfig,
    fromVersion: number,
  ): Promise<{ ok: true; plain: PlainConfig; configVersion: number } | { ok: false }> {
    const hosted = this.pluginOf(id);
    if (!hosted) return { ok: false };
    const { configuration } = hosted.plugin;
    let migrated = plain as JsonObject;
    try {
      for (let version = fromVersion; version < configuration.version; version++) {
        if (!configuration.migrations?.[version]) return { ok: false };
        migrated = await hosted.migrate(version, migrated);
      }
    } catch {
      return { ok: false };
    }
    return { ok: true, plain: migrated, configVersion: Math.max(fromVersion, configuration.version) };
  }

  /** The plugin of an offered Source Type whose manifest and description pass the checks. */
  private pluginOf(id: string): HostedPlugin | null {
    const found = this.offered.get(id);
    if (!found || found.installed.notLoadable !== null || this.loadFailures.has(id)) return null;
    const { plugin } = found.hosted;
    const problems = plugin.identity.sourceTypeId !== id
      ? [`the code is for Source Type "${plugin.identity.sourceTypeId}", the manifest for "${id}"`]
      : problemsWith(plugin);
    if (problems.length > 0) {
      this.loadFailures.set(id, problems.join("; "));
      return null;
    }
    return found.hosted;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadedSourceType(plugin: SourcePlugin): LoadedSourceType {
  const { configuration, setupSteps, ingestion, health, catalogue } = plugin;
  return {
    configuration: {
      version: configuration.version,
      fields: configuration.fields.map(({ key, label, secret, required, description, setByPlugin, choices }) => ({
        key,
        label,
        secret,
        required,
        description: description ?? null,
        setByPlugin: setByPlugin === true,
        choice: choices !== undefined,
      })),
    },
    setupSteps: setupSteps.map(({ id, title, description, progress }) => ({ id, title, description, live: progress !== undefined })),
    catalogue: catalogue
      ? {
          title: catalogue.title,
          configKey: catalogue.configKey,
          async entries() {
            try {
              return (await catalogue.entries()).map(({ id, displayName, description, installed, riskNotice }) => ({
                id,
                displayName,
                description,
                installed,
                riskNotice: riskNotice ?? null,
              }));
            } catch (error) {
              console.warn(`Listing the catalogue of Source Type "${plugin.identity.sourceTypeId}" failed:`, error);
              return [];
            }
          },
        }
      : null,
    // A hosted plugin runs no services; the protocol has no calls for them yet.
    services: null,
    async choices(key, context) {
      const field = configuration.fields.find((candidate) => candidate.key === key);
      try {
        const values = (await field?.choices?.(runContextOf(context))) ?? [];
        return values.filter((choice) => typeof choice.value === "string" && typeof choice.label === "string");
      } catch {
        // Without them, the field offers what was chosen before.
        return [];
      }
    },
    async setupProgress(stepId, context) {
      const step = setupSteps.find((candidate) => candidate.id === stepId);
      try {
        const progress = step?.progress ? await step.progress(runContextOf(context)) : null;
        if (!progress) return { status: "failed", message: `The setup step "${stepId}" is not driven live.` };
        return normalizedProgress(progress);
      } catch (error) {
        return { status: "failed", message: messageOf(error) };
      }
    },
    async sourceAdded({ plain, secrets, now, timeZone }) {
      if (!plugin.sourceAdded) return { ok: true, plain: {}, secrets: {} };
      try {
        const prepared = await plugin.sourceAdded({ config: { plain: plain as JsonObject, secrets }, now, timeZone });
        return { ok: true, plain: prepared.plain, secrets: prepared.secrets };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    },
    async sourceRemoved(context) {
      try {
        await plugin.sourceRemoved?.(runContextOf(context));
      } catch (error) {
        console.warn(`Cleaning up after a removed Source of type "${plugin.identity.sourceTypeId}" failed:`, error);
      }
    },
    ingestion:
      ingestion.mode === "polling"
        ? {
            mode: "polling",
            suggestedIntervalSeconds: ingestion.suggestedIntervalSeconds,
            poll: (context) => run(() => ingestion.poll(runContextOf(context))),
          }
        : { mode: "push" },
    silentApplies: health.silentApplies,
  };
}

/** The Source Attributes a plugin declared, with trimmed names; null if one lacks an id or a name. */
function checkedDeclarations(declared: SourceAttributeDeclaration[]): DeclaredAttribute[] | null {
  if (declared.some(({ externalId, name }) => typeof externalId !== "string" || externalId === "" || typeof name !== "string" || name.trim() === "")) {
    return null;
  }
  return declared.map(({ externalId, name }) => ({ externalId, name: name.trim() }));
}

function runContextOf(context: SourceRunContext) {
  const { plain, secrets, syncCursor, now, timeZone, signal } = context;
  return { config: { plain: plain as JsonObject, secrets }, syncCursor, now, timeZone, ...(signal ? { signal } : {}) };
}

/** A plugin's run as the core sees it: what it emitted, or why it failed. */
async function run(ingest: () => Promise<IngestResult>): Promise<SourceRunResult> {
  let result: IngestResult;
  try {
    result = await ingest();
  } catch (error) {
    if (error instanceof SourceError) return { ok: false, kind: error.kind, message: error.message };
    // An error the plugin did not expect may well be gone next time.
    return { ok: false, kind: "temporary", message: messageOf(error) };
  }
  return outcomeOf(result);
}

/** What a plugin that did not throw emitted, or why the core refuses it. */
function outcomeOf(result: IngestResult): SourceRunResult {
  const problems = result.origins.flatMap(problemsWithOrigin);
  if (problems.length > 0) {
    return { ok: false, kind: "definite", message: `The plugin emitted invalid Origins: ${problems.join("; ")}` };
  }
  const declared = checkedDeclarations(result.declaredAttributes ?? []);
  if (declared === null) {
    return { ok: false, kind: "definite", message: "The plugin declared a Source Attribute without an id or a name." };
  }
  return {
    ok: true,
    declared,
    archived: (result.archivedAttributes ?? []).filter((id) => typeof id === "string" && id !== ""),
    syncCursor: result.syncCursor,
    withdrawn: (result.withdrawn ?? []).filter((id) => typeof id === "string" && id !== ""),
    origins: result.origins.map((origin) => ({
      externalId: origin.externalId,
      attributes: origin.attributes,
      sender: origin.sender ?? null,
      subject: origin.subject ?? null,
      link: origin.link ?? null,
      // A stated Item has no time of its own, even if the plugin gives one.
      occurredAt: origin.content.kind === "stated" ? null : (origin.occurredAt ?? null),
      stated: origin.content.kind === "stated" ? (origin.content.stated as Record<string, unknown>) : null,
      message:
        origin.content.kind === "raw-message"
          ? { text: origin.content.text, attachments: origin.content.attachments }
          : null,
    })),
  };
}

function normalizedProgress(progress: SetupProgress): Awaited<ReturnType<LoadedSourceType["setupProgress"]>> {
  if (progress.status === "waiting") return { status: "waiting", qrCode: progress.qrCode ?? null, message: progress.message ?? null };
  if (progress.status === "done") return { status: "done", message: progress.message ?? null };
  return progress;
}

function installedOf(manifest: SourcePluginManifest): InstalledSourceType {
  const problems = problemsWithManifest(manifest);
  return {
    id: manifest.identity.sourceTypeId as SourceTypeId,
    displayName: manifest.identity.displayName,
    description: manifest.description,
    version: manifest.identity.version,
    needsLlm: manifest.needsLlm,
    riskNotice: manifest.riskNotice ?? null,
    notLoadable: problems.length > 0 ? problems.join("; ") : null,
  };
}
