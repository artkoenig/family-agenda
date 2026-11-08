import { describe, expect, it } from "vitest";
import type { SourceTypeId } from "@family-agenda/domain";
import { encode, type AvailablePlugin, type CallOutcome, type PluginDescription } from "@family-agenda/plugin-protocol";
import { sdkVersion, type SourcePluginManifest } from "@family-agenda/source-sdk";
import { SourceRegistry } from "../src/source-registry";

const idOf = (value: string) => value as SourceTypeId;

const describedAs = (sourceTypeId: string, overrides: Partial<PluginDescription> = {}): PluginDescription => ({
  identity: { sourceTypeId, displayName: sourceTypeId, version: "1.0.0", sdkVersion },
  configuration: { version: 1, fields: [], migrations: [] },
  setupSteps: [
    { id: "live", title: "Live", description: "Live.", live: true },
    { id: "static", title: "Static", description: "Static.", live: false },
  ],
  ingestion: { mode: "polling", suggestedIntervalSeconds: 600 },
  health: { silentApplies: true },
  catalogue: null,
  sourceAdded: false,
  sourceRemoved: false,
  ...overrides,
});

const manifestOf = (description: PluginDescription, overrides: Partial<SourcePluginManifest> = {}): SourcePluginManifest => ({
  entry: "./index.js",
  identity: description.identity,
  description: "A test plugin.",
  needsLlm: false,
  esModule: true,
  ...overrides,
});

type Answer = (args: unknown[]) => CallOutcome;

/** A Plugin Host that offers `plugins` and answers each call `<id>/<call>` as `answers` says. */
const registryWith = (plugins: AvailablePlugin[], answers: Record<string, Answer> = {}) =>
  SourceRegistry.fromPluginHost({
    url: "http://host",
    token: "t",
    fetch: ((url: URL, init: RequestInit) => {
      const [, , id, call] = url.pathname.split("/");
      if (id === undefined) return Promise.resolve(new Response(encode(plugins)));
      const args = JSON.parse(init.body as string) as unknown[];
      return Promise.resolve(new Response(encode(answers[`${id}/${call}`]?.(args) ?? { ok: true, value: null })));
    }) as typeof globalThis.fetch,
  });

const offered = (description: PluginDescription, manifest = manifestOf(description)): AvailablePlugin => ({ manifest, description });

const context = { plain: {}, secrets: {}, syncCursor: null, now: new Date(), timeZone: "UTC" };

describe("the Source registry", () => {
  it("lists the Source Types the Plugin Host offers", async () => {
    const registry = await registryWith([offered(describedAs("good")), offered(describedAs("old"), manifestOf(describedAs("old"), { identity: { ...describedAs("old").identity, sdkVersion: "9.0.0" } }))]);

    expect(registry.installed()).toEqual([
      { id: "good", displayName: "good", description: "A test plugin.", version: "1.0.0", needsLlm: false, riskNotice: null, notLoadable: null },
      expect.objectContaining({ id: "old", notLoadable: expect.stringContaining("9.0.0") as unknown }),
    ]);
    expect(await registry.load(idOf("old"))).toEqual({ ok: false });
  });

  it("loads a plugin once and reports the progress of its live setup steps", async () => {
    let progress: unknown = { status: "waiting", qrCode: "QR" };
    const registry = await registryWith([offered(describedAs("good"))], { "good/setupProgress": () => ({ ok: true, value: progress }) });
    const loaded = await registry.load(idOf("good"));
    if (!loaded.ok) throw new Error("not loaded");
    const { sourceType } = loaded;

    expect(await sourceType.setupProgress("live", context)).toEqual({ status: "waiting", qrCode: "QR", message: null });
    progress = { status: "done" };
    expect(await sourceType.setupProgress("live", context)).toEqual({ status: "done", message: null });
    progress = { status: "failed", message: "denied" };
    expect(await sourceType.setupProgress("live", context)).toEqual({ status: "failed", message: "denied" });
    expect(await sourceType.setupProgress("static", context)).toMatchObject({ status: "failed" });
    expect(await sourceType.setupProgress("unknown", context)).toMatchObject({ status: "failed" });
    expect(sourceType.services).toBeNull();
    expect(await registry.load(idOf("good"))).toEqual({ ok: true, sourceType });
  });

  it("reports a failing live setup step as failed", async () => {
    const registry = await registryWith([offered(describedAs("broken-step"))], {
      "broken-step/setupProgress": () => ({ ok: false, failure: { sourceError: null, message: "no network" } }),
    });
    const loaded = await registry.load(idOf("broken-step"));
    if (!loaded.ok) throw new Error("not loaded");

    expect(await loaded.sourceType.setupProgress("live", context)).toEqual({ status: "failed", message: "no network" });
  });

  it("cannot load a plugin that describes another Source Type or breaks the contract, and says why", async () => {
    const registry = await registryWith([
      offered(describedAs("other"), manifestOf(describedAs("mismatch"))),
      offered(describedAs("invalid", { ingestion: { mode: "polling", suggestedIntervalSeconds: 0 } })),
    ]);

    for (const id of ["mismatch", "invalid"]) expect(await registry.load(idOf(id))).toEqual({ ok: false });
    expect(Object.fromEntries(registry.installed().map((installed) => [installed.id, installed.notLoadable]))).toEqual({
      mismatch: 'the code is for Source Type "other", the manifest for "mismatch"',
      invalid: "the suggested polling interval must be positive",
    });
    expect(await registry.load(idOf("mismatch"))).toEqual({ ok: false });
  });

  it("migrates a stored configuration on the host, step by step to the plugin's version", async () => {
    const registry = await registryWith([offered(describedAs("migrating", { configuration: { version: 3, fields: [], migrations: [1, 2] } }))], {
      "migrating/migrate": ([from, plain]) => ({ ok: true, value: { ...(plain as object), [`from${String(from)}`]: true } }),
    });

    expect(await registry.migrateConfig(idOf("migrating"), { a: 1 }, 1)).toEqual({ ok: true, plain: { a: 1, from1: true, from2: true }, configVersion: 3 });
    expect(await registry.migrateConfig(idOf("migrating"), { a: 1 }, 3)).toEqual({ ok: true, plain: { a: 1 }, configVersion: 3 });
  });

  it("does not migrate for a Source Type that cannot be loaded, lacks a migration step or fails migrating", async () => {
    const registry = await registryWith(
      [
        offered(describedAs("other"), manifestOf(describedAs("broken"))),
        offered(describedAs("gap", { configuration: { version: 3, fields: [], migrations: [1] } })),
        offered(describedAs("failing", { configuration: { version: 2, fields: [], migrations: [1] } })),
      ],
      { "failing/migrate": () => ({ ok: false, failure: { sourceError: null, message: "boom" } }) },
    );

    expect(await registry.migrateConfig(idOf("broken"), {}, 1)).toEqual({ ok: false });
    expect(await registry.migrateConfig(idOf("gap"), {}, 1)).toEqual({ ok: false });
    expect(await registry.migrateConfig(idOf("failing"), {}, 1)).toEqual({ ok: false });
  });

  it("cannot load an unknown Source Type", async () => {
    const registry = await registryWith([]);

    expect(await registry.load(idOf("unknown"))).toEqual({ ok: false });
    expect(await registry.migrateConfig(idOf("unknown"), {}, 1)).toEqual({ ok: false });
  });
});
