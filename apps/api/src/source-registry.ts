import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AttributeReporting,
  InstalledSourceType,
  LoadedSourceType,
  PlainConfig,
  SourceRunContext,
  SourceRunResult,
  SourceTypeRegistry,
} from "@family-agenda/application";
import type { SourceTypeId } from "@family-agenda/domain";
import {
  parseManifest,
  problemsWith,
  problemsWithManifest,
  problemsWithOrigin,
  SourceError,
  type IngestResult,
  type JsonObject,
  type SetupProgress,
  type SourceAttributes,
  type SourcePlugin,
  type SourcePluginManifest,
  type ManifestResult,
} from "@family-agenda/source-sdk";

type Discovered = {
  installed: InstalledSourceType;
  /** Absent when the manifest alone keeps the plugin from loading. */
  module?: string;
};

/**
 * The Source plugins found at startup (ADR-0010): packages in the given directories, such as
 * the workspace's `packages/` and the `plugins/` volume, whose `package.json` holds a
 * `familyAgenda.sourcePlugin` manifest. Discovering reads manifests only; a plugin's code is
 * loaded when it is first asked for, which only happens for enabled Source Types.
 */
export class SourceRegistry implements SourceTypeRegistry {
  private readonly loading = new Map<string, Promise<LoadedSourceType | null>>();
  private readonly loadFailures = new Map<string, string>();

  private constructor(private readonly discovered: Map<string, Discovered>) {}

  /** The first package declaring a Source Type id wins; later ones are ignored with a warning. */
  static async discover(directories: string[]): Promise<SourceRegistry> {
    shareSdkWith(directories);
    const discovered = new Map<string, Discovered>();
    for (const directory of directories) {
      for (const packageDirectory of await packageDirectoriesIn(directory)) {
        const found = await discoverPackage(packageDirectory);
        if (!found) continue;
        const { id } = found.installed;
        if (discovered.has(id)) {
          console.warn(`Ignoring ${packageDirectory}: Source Type "${id}" is already installed.`);
          continue;
        }
        discovered.set(id, found);
      }
    }
    return new SourceRegistry(discovered);
  }

  installed(): InstalledSourceType[] {
    return [...this.discovered.values()].map(({ installed }) => {
      const failure = this.loadFailures.get(installed.id);
      return failure ? { ...installed, notLoadable: failure } : installed;
    });
  }

  async load(id: SourceTypeId): Promise<{ ok: true; sourceType: LoadedSourceType } | { ok: false }> {
    let loading = this.loading.get(id);
    if (!loading) {
      loading = this.import(id);
      this.loading.set(id, loading);
    }
    const sourceType = await loading;
    return sourceType ? { ok: true, sourceType } : { ok: false };
  }

  private async import(id: string): Promise<LoadedSourceType | null> {
    const found = this.discovered.get(id);
    if (!found?.module || found.installed.notLoadable !== null) return null;
    const loaded = await loadPlugin(found.module, id);
    if ("problems" in loaded) {
      this.loadFailures.set(id, loaded.problems.join("; "));
      return null;
    }
    return loadedSourceType(loaded.plugin);
  }
}

/** The plugin an entry module exports, or what keeps it from being one. */
async function loadPlugin(module: string, id: string): Promise<{ plugin: SourcePlugin } | { problems: string[] }> {
  try {
    const imported = (await import(pathToFileURL(module).href)) as { default?: SourcePlugin };
    const plugin = imported.default;
    if (!plugin) return { problems: ["the entry module has no default export"] };
    const problems = plugin.identity.sourceTypeId !== id
      ? [`the code is for Source Type "${plugin.identity.sourceTypeId}", the manifest for "${id}"`]
      : problemsWith(plugin);
    return problems.length > 0 ? { problems } : { plugin };
  } catch (error) {
    return { problems: [`loading the code failed: ${messageOf(error)}`] };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sdkSpecifier = "@family-agenda/source-sdk";

/** Directories, as URL prefixes, whose plugins import the SDK through `shareSdkWith`. */
const sharingDirectories = new Set<string>();
let hookRegistered = false;

/**
 * Lets the plugins in `directories` import the SDK by its package name although no
 * `node_modules` above them holds it, as in the `plugins/` volume. Node resolves their import as
 * it resolves the Instance's own, so that plugins and core share one SDK and, with it, one
 * `SourceError`. Applies to Node's loader, not to the one of the test runner.
 */
function shareSdkWith(directories: string[]): void {
  if (!hookRegistered) {
    hookRegistered = true;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const fromPlugin =
          specifier === sdkSpecifier &&
          [...sharingDirectories].some((directory) => context.parentURL?.startsWith(directory));
        return nextResolve(specifier, fromPlugin ? { ...context, parentURL: import.meta.url } : context);
      },
    });
  }
  for (const directory of directories) {
    // Node reports a plugin parentURL with the real path (macOS resolves /var and /tmp to /private/...),
    // so match that, or the hook below never fires and the plugin cannot resolve the SDK.
    let resolved = directory;
    try {
      resolved = realpathSync(directory);
    } catch {
      // The directory does not exist yet; its unresolvable prefix matches nothing.
    }
    sharingDirectories.add(pathToFileURL(join(resolved, "/")).href);
  }
}

function loadedSourceType(plugin: SourcePlugin): LoadedSourceType {
  const { configuration, setupSteps, ingestion, health, catalogue, services } = plugin;
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
              const value = (await catalogue.entries()).map(({ id, displayName, description, installed, riskNotice }) => ({
                id,
                displayName,
                description,
                installed,
                riskNotice: riskNotice ?? null,
              }));
              return { ok: true, value };
            } catch (error) {
              console.warn(`Listing the catalogue of Source Type "${plugin.identity.sourceTypeId}" failed:`, error);
              return { ok: false, message: messageOf(error) };
            }
          },
        }
      : null,
    services: services ? { reconcile: (enabled) => services.reconcile(enabled), stop: () => services.stop() } : null,
    async choices(key, context) {
      const field = configuration.fields.find((candidate) => candidate.key === key);
      try {
        const values = (await field?.choices?.(runContextOf(context))) ?? [];
        return { ok: true, value: values.filter((choice) => typeof choice.value === "string" && typeof choice.label === "string") };
      } catch (error) {
        console.warn(`Listing the choices of Source Type "${plugin.identity.sourceTypeId}" failed:`, error);
        return { ok: false, message: messageOf(error) };
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
            poll: (context, attributes) => run(() => ingestion.poll({ ...runContextOf(context), attributes: checkedAttributes(attributes) })),
          }
        : {
            mode: "push",
            receive: (context, payload, attributes) => run(() => ingestion.receive({ ...runContextOf(context), attributes: checkedAttributes(attributes) }, payload)),
          },
    silentApplies: health.silentApplies,
    async migrateConfig(plain: PlainConfig, fromVersion: number): Promise<PlainConfig> {
      let migrated = plain as JsonObject;
      for (let version = fromVersion; version < configuration.version; version++) {
        const migrate = configuration.migrations?.[version];
        if (!migrate) throw new Error(`Migrating the configuration from version ${version} failed: the plugin has no migration for it`);
        // An in-process migration may be synchronous; awaiting keeps both kinds working.
        migrated = await Promise.resolve(migrate(migrated));
      }
      return migrated;
    },
  };
}

/** What a plugin reports its Source's Source Attributes through; one declared without an id or a name fails its run. */
function checkedAttributes(reporting: AttributeReporting): SourceAttributes {
  return {
    declare(attributes) {
      if (attributes.some(({ externalId, name }) => typeof externalId !== "string" || externalId === "" || typeof name !== "string" || name.trim() === "")) {
        return Promise.reject(SourceError.definite("The plugin declared a Source Attribute without an id or a name."));
      }
      return reporting.declare(attributes.map(({ externalId, name }) => ({ externalId, name: name.trim() })));
    },
    archive: (externalId) => reporting.archive(externalId),
  };
}

function runContextOf(context: SourceRunContext) {
  const { plain, secrets, syncCursor, now, timeZone } = context;
  return { config: { plain: plain as JsonObject, secrets }, syncCursor, now, timeZone };
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
  const problems = result.origins.flatMap(problemsWithOrigin);
  if (problems.length > 0) {
    return { ok: false, kind: "definite", message: `The plugin emitted invalid Origins: ${problems.join("; ")}` };
  }
  return {
    ok: true,
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

async function packageDirectoriesIn(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function discoverPackage(packageDirectory: string): Promise<Discovered | null> {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const result = parseManifest(packageJson);
  if (!result.ok) return manifestProblem(packageDirectory, result);
  return { installed: installedOf(result.manifest), module: join(packageDirectory, result.manifest.entry) };
}

function manifestProblem(packageDirectory: string, result: Extract<ManifestResult, { ok: false }>): Discovered | null {
  if (result.problem === "no-manifest") return null;
  if (!result.sourceTypeId) {
    console.warn(`Ignoring ${packageDirectory}: its Source plugin manifest has no Source Type id.`);
    return null;
  }
  const id = result.sourceTypeId as SourceTypeId;
  return {
    installed: {
      id,
      displayName: id,
      description: "",
      version: "",
      needsLlm: false,
      riskNotice: null,
      notLoadable: `the manifest is invalid: ${result.details.join("; ")}`,
      notReachable: null,
    },
  };
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
    notReachable: null,
  };
}
