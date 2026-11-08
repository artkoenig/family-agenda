import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginManager } from "../src/manager";

/** A plugin whose poll runs `probe` and returns what it gave, or threw, as its sync cursor. */
const probePlugin = (id: string, probe: string) => `
import * as fs from "node:fs";
export default {
  identity: { sourceTypeId: ${JSON.stringify(id)}, displayName: "Probe", version: "1.0.0", sdkVersion: "2.0.0" },
  configuration: { version: 2, fields: [{ key: "a", label: "A", secret: false, required: false, choices: async () => [{ value: "x", label: "X" }] }], migrations: { 1: (plain) => ({ ...plain, migrated: true }) } },
  setupSteps: [{ id: "s", title: "S", description: "S" }],
  ingestion: { mode: "polling", suggestedIntervalSeconds: 60, async poll(context) {
    if (context.config.plain.fail) { const e = new Error("bad password"); e.name = "SourceError"; e.kind = "definite"; throw e; }
    let out; try { out = String(await (async () => { ${probe} })()); } catch (error) { out = "denied: " + (error.code ?? error.message); }
    return { origins: [{ externalId: "o", attributes: [], occurredAt: context.now, content: { kind: "raw-message", text: "t", attachments: [{ filename: "f", contentType: "x", bytes: new Uint8Array([1, 2]) }] } }], syncCursor: out };
  } },
  health: { silentApplies: false },
};`;

describe("the plugin manager", () => {
  let work: string;
  let manager: PluginManager;
  beforeEach(async () => {
    work = await realpath(await mkdtemp(join(tmpdir(), "plugin-host-")));
    manager = new PluginManager({ workDirectory: work, firstUserId: null, memoryMb: 64, openFiles: 64, callTimeoutMs: 5_000 });
  });
  afterEach(async () => {
    manager.stop();
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  });

  const probe = async (code: string, id = "probe") => {
    const installed = await manager.install(id, probePlugin(id, code));
    expect(installed.ok).toBe(true);
    const outcome = await manager.call(id, "poll", [{ config: { plain: {}, secrets: {} }, syncCursor: null, now: new Date("2026-01-01T00:00:00Z"), timeZone: "UTC" }]);
    if (!outcome?.ok) throw new Error(JSON.stringify(outcome));
    return (outcome.value as { syncCursor: string }).syncCursor;
  };

  it("describes an installed plugin without its functions", async () => {
    const installed = await manager.install("probe", probePlugin("probe", "return 1"));

    expect(installed).toMatchObject({
      ok: true,
      description: {
        identity: { sourceTypeId: "probe" },
        configuration: { version: 2, migrations: [1], fields: [{ key: "a", choices: true }] },
        setupSteps: [{ id: "s", live: false }],
        ingestion: { mode: "polling", suggestedIntervalSeconds: 60 },
        catalogue: null,
        sourceAdded: false,
      },
    });
  });

  it("answers calls with dates and bytes, and passes Source errors on", async () => {
    await manager.install("probe", probePlugin("probe", "return 1"));
    const context = (plain: object) => ({ config: { plain, secrets: {} }, syncCursor: null, now: new Date("2026-01-01T00:00:00Z"), timeZone: "UTC" });

    const polled = await manager.call("probe", "poll", [context({})]);
    const failed = await manager.call("probe", "poll", [context({ fail: true })]);

    const origin = (polled as { value: { origins: { occurredAt: Date; content: { attachments: { bytes: Uint8Array }[] } }[] } }).value.origins[0];
    expect(origin?.occurredAt).toBeInstanceOf(Date);
    expect(origin?.content.attachments[0]?.bytes).toBeInstanceOf(Uint8Array);
    expect(failed).toEqual({ ok: false, failure: { sourceError: "definite", message: "bad password" } });
    expect(await manager.call("probe", "migrate", [1, { a: "b" }])).toEqual({ ok: true, value: { a: "b", migrated: true } });
    expect(await manager.call("probe", "choices", ["a", context({})])).toEqual({ ok: true, value: [{ value: "x", label: "X" }] });
    expect(await manager.call("other", "poll", [])).toBeNull();
  });

  it("refuses a bundle for another Source Type", async () => {
    expect(await manager.install("ics", probePlugin("probe", "return 1"))).toMatchObject({ ok: false });
  });

  it("gives a plugin an empty environment and its own temp space", async () => {
    expect(await probe("return JSON.stringify(process.env)")).toBe(JSON.stringify({ TMPDIR: join(work, "0", "tmp") }));
    expect(await probe('fs.writeFileSync(process.env.TMPDIR + "/x", "y"); return fs.readFileSync(process.env.TMPDIR + "/x", "utf8")')).toBe("y");
  });

  it("keeps a plugin from reading other plugins' files and the manager's", async () => {
    await probe("return 1", "first");

    expect(await probe(`return fs.readFileSync(${JSON.stringify(join(work, "0", "plugin.mjs"))}, "utf8")`, "second")).toBe("denied: ERR_ACCESS_DENIED");
    expect(await probe(`return fs.readdirSync(${JSON.stringify(work)})`, "third")).toBe("denied: ERR_ACCESS_DENIED");
    expect(await probe('return fs.readFileSync("/etc/passwd", "utf8")', "fourth")).toBe("denied: ERR_ACCESS_DENIED");
  });

  it("denies spawning processes, workers and native addons", async () => {
    expect(await probe('const cp = await import("node:child_process"); return cp.execSync("id")')).toBe("denied: ERR_ACCESS_DENIED");
    expect(await probe('const { Worker } = await import("node:worker_threads"); new Worker("1", { eval: true }); return 1', "worker")).toBe("denied: ERR_ACCESS_DENIED");
    expect(await probe("process.dlopen({ exports: {} }, process.env.TMPDIR + '/addon.node'); return 1", "addon")).toMatch(/^denied: ERR_(DLOPEN_DISABLED|ACCESS_DENIED)/);
  });

  it("runs each call in a process of its own, sharing no state", async () => {
    await manager.install("probe", probePlugin("probe", "globalThis.calls = (globalThis.calls ?? 0) + 1; return globalThis.calls"));
    const context = { config: { plain: {}, secrets: {} }, syncCursor: null, now: new Date(), timeZone: "UTC" };

    const outcomes = await Promise.all([1, 2, 3].map(() => manager.call("probe", "poll", [context])));
    for (const outcome of [...outcomes, await manager.call("probe", "poll", [context])]) expect(outcome).toMatchObject({ ok: true, value: { syncCursor: "1" } });
  });

  it("limits memory and open files", async () => {
    manager = new PluginManager({ workDirectory: work, firstUserId: null, memoryMb: 1024, openFiles: 64, callTimeoutMs: 5_000 });
    expect(await probe('const v8 = await import("node:v8"); const mb = v8.getHeapStatistics().heap_size_limit / 1048576; return mb >= 1024 && mb < 1400')).toBe("true");
    expect(await probe("const f = process.env.TMPDIR + '/f'; fs.writeFileSync(f, ''); for (let i = 0; i < 100; i++) fs.openSync(f, 'r'); return 'opened'", "files")).toBe("denied: EMFILE");
  });

  it("ends a call that does not answer in time, leaving the calls running beside it alone", async () => {
    manager = new PluginManager({ workDirectory: work, firstUserId: null, memoryMb: 64, openFiles: 64, callTimeoutMs: 1_000 });
    await manager.install("probe", probePlugin("probe", "return 1").replace("async poll(context) {", "async poll(context) { if (context.syncCursor === 'hang') await new Promise(() => setInterval(() => {}, 1000));"));
    const context = (syncCursor: string | null) => ({ config: { plain: {}, secrets: {} }, syncCursor, now: new Date(), timeZone: "UTC" });

    const hanging = manager.call("probe", "poll", [context("hang")]);
    const beside = manager.call("probe", "poll", [context(null)]);

    expect(await hanging).toEqual({ ok: false, failure: { sourceError: "temporary", message: "The plugin did not answer in time." } });
    expect(await beside).toMatchObject({ ok: true });
    expect(await manager.call("probe", "poll", [context(null)])).toMatchObject({ ok: true });
  });
});
