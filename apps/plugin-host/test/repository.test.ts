import { createHash } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SourcePluginManifest } from "@family-agenda/source-sdk";
import { PluginManager } from "../src/manager";
import { MockPluginRepository } from "../src/mock-repository";
import { installFromRepository, type PluginRepository } from "../src/repository";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const manifestOf = (id: string): SourcePluginManifest => ({ entry: "./index.js", identity: { sourceTypeId: id, displayName: id, version: "1.0.0", sdkVersion: "2.0.0" }, description: id, needsLlm: false, esModule: true });
const bundleOf = (id: string) => `export default { identity: { sourceTypeId: "${id}", displayName: "${id}", version: "1.0.0", sdkVersion: "2.0.0" }, configuration: { version: 1, fields: [] }, setupSteps: [], ingestion: { mode: "polling", suggestedIntervalSeconds: 60, poll: async () => ({ origins: [], syncCursor: null }) }, health: { silentApplies: false } };`;

describe("installing from the Plugin Repository", () => {
  let manager: PluginManager;
  afterEach(() => {
    manager.stop();
  });
  const managerIn = async () => (manager = new PluginManager({ workDirectory: await realpath(await mkdtemp(join(tmpdir(), "plugin-repo-"))), firstUserId: null, memoryMb: 64, openFiles: 64, callTimeoutMs: 5_000 }));

  it("installs each published plugin whose bundle matches its hash, and leaves out the others with the reason", async () => {
    const repository: PluginRepository = {
      index: () => Promise.resolve([
        { manifest: manifestOf("good"), sha256: sha256(bundleOf("good")) },
        { manifest: manifestOf("tampered"), sha256: sha256("something else") },
        { manifest: manifestOf("missing"), sha256: "" },
        { manifest: manifestOf("broken"), sha256: sha256("export default 1") },
      ]),
      bundle: (id) => (id === "missing" ? Promise.reject(new Error("gone")) : Promise.resolve(id === "broken" ? "export default 1" : bundleOf(id))),
    };

    const { available, failures } = await installFromRepository(await managerIn(), repository);

    expect(available.map(({ manifest, description }) => [manifest.identity.sourceTypeId, description.identity.sourceTypeId])).toEqual([["good", "good"]]);
    expect(failures).toEqual([
      expect.stringMatching(/"tampered".*does not match the hash/),
      expect.stringMatching(/"missing".*gone/),
      expect.stringContaining('"broken"'),
    ]);
    expect(await manager.call("tampered", "poll", [])).toBeNull();
  });

  it("is mocked by the workspace's packages, bundled", async () => {
    const repository = await MockPluginRepository.fromPackages([join(root, "packages/source-ics")]);
    const [entry] = await repository.index();

    expect(entry?.manifest.identity.sourceTypeId).toBe("ics");
    expect(sha256(await repository.bundle("ics"))).toBe(entry?.sha256);
    await expect(repository.bundle("other")).rejects.toThrow('no plugin "other"');
    await expect(MockPluginRepository.fromPackages([join(root, "packages/domain")])).rejects.toThrow("no valid Source plugin manifest");
  });
});
