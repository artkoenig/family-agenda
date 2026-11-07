import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceTypeId } from "@family-agenda/domain";
import { sdkVersion } from "@family-agenda/source-sdk";
import { SourceRegistry } from "../src/source-registry";

const idOf = (value: string) => value as SourceTypeId;

describe("the Source registry", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "family-agenda-registry-"));
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  /** A package holding a Source plugin whose entry module has the given code. */
  const writePackage = async (name: string, code: string, sourceTypeId = name) => {
    await mkdir(join(directory, name));
    await writeFile(
      join(directory, name, "package.json"),
      JSON.stringify({
        name,
        type: "module",
        familyAgenda: { sourcePlugin: { entry: "./index.mjs", sourceTypeId, displayName: name, sdkVersion, description: "A test plugin." } },
      }),
    );
    await writeFile(join(directory, name, "index.mjs"), code);
  };

  const plugin = (sourceTypeId: string, extras = "") => `export default {
  identity: { sourceTypeId: ${JSON.stringify(sourceTypeId)}, displayName: "Test", version: "1.0.0", sdkVersion: ${JSON.stringify(sdkVersion)} },
  configuration: { version: 1, fields: [] },
  setupSteps: [
    { id: "live", title: "Live", description: "Live.", progress: async () => globalThis.progress ?? null },
    { id: "static", title: "Static", description: "Static." },
  ],
  ingestion: { mode: "polling", suggestedIntervalSeconds: 600, poll: async () => ({ origins: [] }) },
  health: { silentApplies: true },
  ${extras}
};`;

  const context = { plain: {}, secrets: {}, syncCursor: null, now: new Date(), timeZone: "UTC" };

  it("finds no packages in a directory that does not exist", async () => {
    const registry = await SourceRegistry.discover([join(directory, "missing")]);

    expect(registry.installed()).toEqual([]);
  });

  it("fails when a directory cannot be read for another reason", async () => {
    await writeFile(join(directory, "file"), "");

    await expect(SourceRegistry.discover([join(directory, "file")])).rejects.toThrow();
  });

  it("loads a plugin once and reports the progress of its live setup steps", async () => {
    await writePackage("good", plugin("good"));
    const registry = await SourceRegistry.discover([directory]);
    const loaded = await registry.load(idOf("good"));
    if (!loaded.ok) throw new Error("not loaded");
    const { sourceType } = loaded;

    (globalThis as { progress?: unknown }).progress = { status: "waiting", qrCode: "QR" };
    expect(await sourceType.setupProgress("live", context)).toEqual({ status: "waiting", qrCode: "QR", message: null });
    (globalThis as { progress?: unknown }).progress = { status: "done" };
    expect(await sourceType.setupProgress("live", context)).toEqual({ status: "done", message: null });
    (globalThis as { progress?: unknown }).progress = { status: "failed", message: "denied" };
    expect(await sourceType.setupProgress("live", context)).toEqual({ status: "failed", message: "denied" });
    (globalThis as { progress?: unknown }).progress = null;
    expect(await sourceType.setupProgress("live", context)).toMatchObject({ status: "failed" });
    expect(await sourceType.setupProgress("static", context)).toMatchObject({ status: "failed" });
    expect(await sourceType.setupProgress("unknown", context)).toMatchObject({ status: "failed" });
    expect(await registry.load(idOf("good"))).toEqual({ ok: true, sourceType });
  });

  it("reports a failing live setup step as failed", async () => {
    await writePackage("broken-step", plugin("broken-step").replace("globalThis.progress ?? null", 'Promise.reject(new Error("no network"))'));
    const registry = await SourceRegistry.discover([directory]);
    const loaded = await registry.load(idOf("broken-step"));
    if (!loaded.ok) throw new Error("not loaded");

    expect(await loaded.sourceType.setupProgress("live", context)).toEqual({ status: "failed", message: "no network" });
  });

  it("cannot load a plugin without a default export, for another Source Type, or throwing on import", async () => {
    await writePackage("empty", "export const nothing = 1;");
    await writePackage("mismatch", plugin("other"), "mismatch");
    await writePackage("throwing", 'throw new Error("boom");');
    const registry = await SourceRegistry.discover([directory]);

    for (const id of ["empty", "mismatch", "throwing"]) expect(await registry.load(idOf(id))).toEqual({ ok: false });
    const failures = Object.fromEntries(registry.installed().map((installed) => [installed.id, installed.notLoadable]));
    expect(failures).toEqual({
      empty: "the entry module has no default export",
      mismatch: 'the code is for Source Type "other", the manifest for "mismatch"',
      throwing: "loading the code failed: boom",
    });
  });

  it("cannot load an unknown Source Type", async () => {
    const registry = await SourceRegistry.discover([directory]);

    expect(await registry.load(idOf("unknown"))).toEqual({ ok: false });
  });
});
