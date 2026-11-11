import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { contractVersion, limits, type RunContext } from "@family-agenda/plugin-contract";
import { PluginError, type PluginImplementation } from "@family-agenda/plugin-kit";
import { servePlugin } from "@family-agenda/plugin-kit/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceId, SourceTypeId } from "@family-agenda/domain";
import { parsePluginUrls } from "../../src/plugin-containers/bindings";
import { descriptionProblem, PluginContainers } from "../../src/plugin-containers/registry";
import { bootForTest, type TestInstance } from "../support/boot";

const minutes = 60 * 1000;

type Poll = (context: RunContext) => Promise<unknown>;

/** A stateless plugin of the Source Type `school-portal`, whose `poll` a test sets. */
function fakePlugin(state: { poll: Poll; runs: RunContext[] }, sourceTypeId = "school-portal"): PluginImplementation {
  return {
    description: {
      sourceTypeId,
      kind: "stateless",
      displayName: { en: "School portal", de: "Schulportal" },
      version: "2.1.0",
      description: "Reads the school portal.",
      needsLlm: false,
      configuration: {
        version: 1,
        fields: [
          { key: "url", label: "Address", secret: false, required: true, hasChoices: false },
          { key: "token", label: "Token", secret: true, required: true, hasChoices: false },
        ],
      },
      setupSteps: [],
      ingestion: { mode: "polling", suggestedIntervalSeconds: 600 },
      silentApplies: false,
    },
    async poll(context) {
      state.runs.push(context);
      return (await state.poll(context)) as never;
    },
  };
}

const evening = {
  externalId: "evening",
  attributes: ["main"],
  content: { kind: "stated", stated: { kind: "event", title: "Parents' evening", span: { allDay: true, firstDay: "2026-09-20", lastDay: "2026-09-20" }, place: null, cancelled: false } },
};

/** Checks that the one Source polled failed so, its message containing `message`. */
function expectFailure(report: { failed: { kind: string; message: string }[] }, kind: string, message: string): void {
  expect(report.failed).toHaveLength(1);
  expect(report.failed[0]?.kind).toBe(kind);
  expect(report.failed[0]?.message).toContain(message);
}

const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const closed = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

describe("A Source Type whose plugin runs in a container", () => {
  let instance: TestInstance;
  let server: Server;
  let state: { poll: Poll; runs: RunContext[] };

  beforeEach(async () => {
    state = { runs: [], poll: () => Promise.resolve({ sourceRecords: [], syncCursor: null }) };
    server = await servePlugin(fakePlugin(state), { host: "127.0.0.1" });
    instance = await bootForTest({
      sourcePlugins: [{ sourceTypeId: "club-mail" }],
      pluginContainers: [{ sourceTypeId: "school-portal" as SourceTypeId, url: urlOf(server) }],
      pluginContainerOptions: { timeoutsMs: { poll: 200 }, descriptionMaxAgeMs: 0 },
    });
    expect(await instance.app.sourceTypes.enable("school-portal")).toEqual({ ok: true });
    const added = await instance.app.sources.add({ sourceTypeId: "school-portal", plain: { url: "https://portal.example.org" }, secrets: { token: "first" } });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
  });
  afterEach(async () => {
    await instance.close();
    if (server.listening) await closed(server);
  });

  const poll = async () => {
    instance.clock.advance(10 * minutes);
    return instance.app.polling.pollDue();
  };
  const listed = async (id: string) => (await instance.app.sourceTypes.list()).find((type) => type.id === id);

  it("is listed as its plugin describes itself, beside the plugins in-process", async () => {
    expect(await listed("school-portal")).toMatchObject({
      displayName: { en: "School portal", de: "Schulportal" },
      version: "2.1.0",
      notLoadable: null,
      notReachable: null,
      enabled: true,
    });
    expect(await listed("club-mail")).toMatchObject({ notLoadable: null, notReachable: null });
  });

  it("stays loadable once the HTTP server has replaced the global Response", async () => {
    vi.stubGlobal("Response", function ServersResponse() {});
    try {
      await poll();
      expect(await listed("school-portal")).toMatchObject({ notLoadable: null });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("polls its Sources with the whole run context and keeps the sync cursor and the secrets it changed", async () => {
    state.poll = () => Promise.resolve({ sourceRecords: [evening], syncCursor: "cursor-1", attributes: { declared: [{ externalId: "main", name: "Class 3b" }], archived: [] }, secrets: { token: "second" } });

    const report = await poll();

    expect(report.failed).toEqual([]);
    expect(report.ran).toHaveLength(1);
    expect(state.runs[0]).toEqual({
      config: { plain: { url: "https://portal.example.org" }, secrets: { token: "first" } },
      syncCursor: null,
      now: "2026-09-14T07:10:00.000Z",
      timeZone: "Europe/Berlin",
    });
    expect(await instance.query("SELECT external_id FROM source_record")).toEqual([{ external_id: "evening" }]);

    state.poll = () => Promise.resolve({ sourceRecords: [], syncCursor: "cursor-2" });
    await poll();

    expect(state.runs[1]).toMatchObject({ syncCursor: "cursor-1", config: { secrets: { token: "second" } } });
    expect((await instance.query("SELECT sync_cursor FROM source_run"))[0]?.sync_cursor).toBe("cursor-2");
  });

  it("receives no pushed payload for its Sources", async () => {
    const source = (await instance.app.sources.list())[0];
    if (!source) throw new Error("no Source");
    expect(await instance.app.polling.receive(source.id, new Uint8Array())).toEqual({ ok: false, problem: "not-push" });
  });

  it("fails a run definitely on a definite error of its plugin", async () => {
    state.poll = () => Promise.reject(new PluginError("definite", "The token was revoked."));

    expect((await poll()).failed).toMatchObject([{ kind: "definite", message: "The token was revoked." }]);
  });

  it("fails a run temporarily when its plugin answers with a server error", async () => {
    state.poll = () => Promise.reject(new Error("The portal is down."));

    expect((await poll()).failed).toMatchObject([{ kind: "temporary", message: "The portal is down." }]);
    const source = (await instance.app.sources.list())[0];
    expect(source?.health.status).not.toBe("failing");
    expect((await listed("school-portal"))?.notReachable, "a plugin that answers is reachable").toBeNull();
  });

  it("fails a run temporarily when its plugin does not answer in time", async () => {
    state.poll = () => new Promise((resolve) => {
        setTimeout(() => {
          resolve({ sourceRecords: [], syncCursor: null });
        }, 1000);
      });

    expectFailure(await poll(), "temporary", "no answer within 0.2 s");
  });

  it("fails a run temporarily and shows the Source Type as not reachable when its plugin is gone", async () => {
    await closed(server);

    expectFailure(await poll(), "temporary", "is not reachable");
    expect(await listed("school-portal")).toMatchObject({
      displayName: { en: "School portal", de: "Schulportal" },
      notLoadable: null,
    });
    expect((await listed("school-portal"))?.notReachable).toContain("is not reachable");
  });

  it("refuses an invalid answer of its plugin definitely", async () => {
    // The kit refuses to send an invalid answer, so the plugin answers one the contract allows but the core does not.
    state.poll = () => Promise.resolve({ sourceRecords: [{ externalId: "mail", attributes: ["main"], content: { kind: "raw-message", text: "Hello", attachments: [] } }], syncCursor: null });

    expectFailure(await poll(), "definite", "without a time");
  });
});

describe("A Source Type whose plugin receives pushed payloads", () => {
  type Receive = (request: { context: RunContext; payload: string }) => Promise<unknown>;
  let instance: TestInstance;
  let server: Server;
  let receive: Receive;
  let sourceId: SourceId;
  let description: PluginImplementation["description"];
  const removed: unknown[] = [];

  beforeEach(async () => {
    receive = () => Promise.resolve({ sourceRecords: [], syncCursor: null });
    removed.length = 0;
    const base = fakePlugin({ runs: [], poll: () => Promise.resolve({}) }, "chat-relay");
    description = { ...base.description, ingestion: { mode: "push" } };
    server = await servePlugin(
      {
        description,
        receive: async (request) => (await receive(request)) as never,
        sourceRemoved: (context) => {
          removed.push(context.config.plain);
        },
      },
      { host: "127.0.0.1" },
    );
    instance = await bootForTest({
      pluginContainers: [{ sourceTypeId: "chat-relay" as SourceTypeId, url: urlOf(server) }],
      pluginContainerOptions: { timeoutsMs: { receive: 200 }, descriptionMaxAgeMs: 0 },
    });
    expect(await instance.app.sourceTypes.enable("chat-relay")).toEqual({ ok: true });
    const added = await instance.app.sources.add({ sourceTypeId: "chat-relay", plain: { url: "https://chat.example.org" }, secrets: { token: "first" } });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    sourceId = added.id;
  });
  afterEach(async () => {
    await instance.close();
    if (server.listening) await closed(server);
  });

  const payload = new TextEncoder().encode("hello");

  it("forwards a pushed payload to its plugin and records what it emitted as for a poll", async () => {
    const requests: { context: RunContext; payload: string }[] = [];
    receive = (request) => {
      requests.push(request);
      return Promise.resolve({ sourceRecords: [evening], syncCursor: "cursor-1", attributes: { declared: [{ externalId: "main", name: "Class 3b" }], archived: [] } });
    };

    const result = await instance.app.polling.receive(sourceId, payload);

    expect(result).toMatchObject({ ok: true, report: { ran: [sourceId], failed: [] } });
    expect(requests).toEqual([{ context: { config: { plain: { url: "https://chat.example.org" }, secrets: { token: "first" } }, syncCursor: null, now: "2026-09-14T07:00:00.000Z", timeZone: "Europe/Berlin" }, payload: "aGVsbG8=" }]);
    expect(await instance.query("SELECT external_id FROM source_record")).toEqual([{ external_id: "evening" }]);
    expect((await instance.query("SELECT sync_cursor FROM source_run"))[0]?.sync_cursor).toBe("cursor-1");
  });

  it("is not polled", async () => {
    instance.clock.advance(60 * minutes);
    expect((await instance.app.polling.pollDue()).ran).toEqual([]);
  });

  it("fails the run temporarily when its plugin answers with a server error or not in time", async () => {
    receive = () => Promise.reject(new Error("The relay is down."));
    expect(await instance.app.polling.receive(sourceId, payload)).toMatchObject({ ok: true, report: { failed: [{ kind: "temporary", message: "The relay is down." }] } });

    receive = () => new Promise((resolve) => {
        setTimeout(() => {
          resolve({ sourceRecords: [], syncCursor: null });
        }, 1000);
      });
    const late = await instance.app.polling.receive(sourceId, payload);
    expect(late.ok && late.report.failed[0]?.message).toContain("no answer within 0.2 s");

    await closed(server);
    const gone = await instance.app.polling.receive(sourceId, payload);
    expect(gone.ok && gone.report.failed[0]).toMatchObject({ kind: "temporary", message: expect.stringContaining("is not reachable") as string });
  });

  it("fails the run definitely on a definite error of its plugin", async () => {
    receive = () => Promise.reject(new PluginError("definite", "The payload is no chat message."));
    expect(await instance.app.polling.receive(sourceId, payload)).toMatchObject({ ok: true, report: { failed: [{ kind: "definite", message: "The payload is no chat message." }] } });
  });

  it("refuses a payload too large for the plugin contract without calling the plugin", async () => {
    let called = false;
    receive = () => {
      called = true;
      return Promise.resolve({ sourceRecords: [], syncCursor: null });
    };
    const result = await instance.app.polling.receive(sourceId, new Uint8Array(limits.maxPayloadBytes));
    expect(result.ok && result.report.failed[0]).toMatchObject({ kind: "definite", message: expect.stringContaining("more than the 10485760 bytes the plugin contract allows") as string });
    expect(called).toBe(false);
  });

  it("runs a pushed payload after the run under way, from the Source Cursor that run left", async () => {
    const cursors: (string | null)[] = [];
    receive = async ({ context, payload: sent }) => {
      cursors.push(context.syncCursor);
      if (sent === "Zmlyc3Q=") await new Promise((resolve) => setTimeout(resolve, 100));
      return { sourceRecords: [], syncCursor: sent };
    };

    const first = instance.app.polling.receive(sourceId, new TextEncoder().encode("first"));
    // The second is pushed while the plugin is still receiving the first.
    await vi.waitFor(() => {
      expect(cursors).toHaveLength(1);
    });
    await Promise.all([first, instance.app.polling.receive(sourceId, payload)]);

    expect(cursors).toEqual([null, "Zmlyc3Q="]);
  });

  it("receives nothing while its plugin is not loadable", async () => {
    description.sourceTypeId = "other-relay";
    expect(await instance.app.polling.receive(sourceId, payload)).toEqual({ ok: false, problem: "source-type-not-available" });
  });

  it("receives nothing for an unknown Source", async () => {
    expect(await instance.app.polling.receive("unknown" as SourceId, payload)).toEqual({ ok: false, problem: "unknown-source" });
  });

  it("notifies its plugin when a Source is removed, and removes it even when the plugin is gone", async () => {
    await instance.app.sources.remove(sourceId);
    expect(removed).toEqual([{ url: "https://chat.example.org" }]);
    expect(await instance.app.sources.list()).toEqual([]);

    const again = await instance.app.sources.add({ sourceTypeId: "chat-relay", plain: { url: "https://other.example.org" }, secrets: { token: "first" } });
    if (!again.ok) throw new Error("adding failed");
    await closed(server);
    await instance.app.sources.remove(again.id);
    expect(await instance.app.sources.list()).toEqual([]);
  });
});

describe("A plugin container bound to another Source Type", () => {
  it("is not loadable", async () => {
    const server = await servePlugin(fakePlugin({ runs: [], poll: () => Promise.resolve({}) }), { host: "127.0.0.1" });
    const instance = await bootForTest({ pluginContainers: [{ sourceTypeId: "club-portal" as SourceTypeId, url: urlOf(server) }] });
    try {
      expect((await instance.app.sourceTypes.list())[0]?.notLoadable).toContain('is for Source Type "school-portal", but it is bound to "club-portal"');
      expect((await instance.app.sourceTypes.enable("club-portal")).ok).toBe(false);
    } finally {
      await instance.close();
      await closed(server);
    }
  });

  it("is not loadable when it never answered", async () => {
    const instance = await bootForTest({ pluginContainers: [{ sourceTypeId: "club-portal" as SourceTypeId, url: "http://127.0.0.1:1" }] });
    try {
      expect((await instance.app.sourceTypes.list())[0]).toMatchObject({
        displayName: "club-portal",
        notLoadable: "the plugin has not described itself yet",
      });
      expect((await instance.app.sourceTypes.list())[0]?.notReachable).toContain("is not reachable");
    } finally {
      await instance.close();
    }
  });
});

describe("The description of a plugin container", () => {
  const binding = { sourceTypeId: "school-portal" as SourceTypeId, url: "http://plugin" };
  const description = { ...fakePlugin({ runs: [], poll: () => Promise.resolve({}) }).description, contractVersion: "2.0", endpoints: { sourceAdded: false, sourceRemoved: false } };

  it("is loadable for the bound Source Type and the core's contract", () => {
    expect(descriptionProblem(binding, description)).toBeNull();
  });

  it("is refused for a plugin contract the core does not implement", () => {
    expect(descriptionProblem(binding, { ...description, contractVersion: "1.3" })).toBe(`built for plugin contract 1.3, but the core implements ${contractVersion}`);
  });
});

describe("PLUGIN_URLS", () => {
  it("binds Source Type ids to URLs", () => {
    expect(parsePluginUrls(" demo=http://demo:8080/ , ics=https://ics.example.org")).toEqual([
      { sourceTypeId: "demo" as SourceTypeId, url: "http://demo:8080" },
      { sourceTypeId: "ics" as SourceTypeId, url: "https://ics.example.org" },
    ]);
    expect(parsePluginUrls(undefined)).toEqual([]);
  });

  it("refuses what is no binding", () => {
    expect(() => parsePluginUrls("demo")).toThrow("PLUGIN_URLS");
    expect(() => parsePluginUrls("Demo=http://demo")).toThrow("PLUGIN_URLS");
    expect(() => parsePluginUrls("demo=ftp://demo")).toThrow("PLUGIN_URLS");
    expect(() => parsePluginUrls("demo=http://a,demo=http://b")).toThrow("twice");
  });
});

describe("The other functions of a plugin container", () => {
  const context = { plain: { url: "https://portal.example.org" }, secrets: { token: "first" }, syncCursor: null, now: new Date("2026-09-14T07:00:00Z"), timeZone: "Europe/Berlin" };
  const removed: unknown[] = [];
  const base = fakePlugin({ runs: [], poll: () => Promise.resolve({}) });
  const plugin: PluginImplementation = {
    ...base,
    description: {
      ...base.description,
      setupSteps: [{ id: "pair", title: "Pair", description: "Scan the code.", live: true }],
      catalogue: { title: "Portals", configKey: "url" },
    },
    sourceAdded: ({ config }) => ({ plain: { account: `for ${String(config.plain.url)}` }, secrets: { token: "issued" } }),
    sourceRemoved: (request) => {
      removed.push(request.config.plain);
    },
    fieldChoices: ({ field }) => ({ choices: [{ value: field, label: "Class 3b" }] }),
    catalogueEntries: () => ({ entries: [{ id: "north", displayName: "North", description: "The north school", installed: true }] }),
    setupProgress: ({ stepId }) => {
      if (stepId === "pair") return { status: "waiting", qrCode: "QR" };
      if (stepId === "done") return { status: "done" };
      return { status: "failed", message: "Pairing failed." };
    },
  };

  const loadedFrom = async (server: Server) => {
    const containers = await PluginContainers.connect([{ sourceTypeId: "school-portal" as SourceTypeId, url: urlOf(server) }]);
    const loaded = await containers.load("school-portal" as SourceTypeId);
    if (!loaded.ok) throw new Error("not loaded");
    return { containers, sourceType: loaded.sourceType };
  };

  it("asks its plugin for its description again only once the last one is a few seconds old", async () => {
    const server = await servePlugin(plugin, { host: "127.0.0.1" });
    const fetching = vi.spyOn(globalThis, "fetch");
    try {
      const { containers } = await loadedFrom(server);
      await containers.load("school-portal" as SourceTypeId);
      expect(fetching).toHaveBeenCalledTimes(1);

      const fresh = await PluginContainers.connect([{ sourceTypeId: "school-portal" as SourceTypeId, url: urlOf(server) }], { descriptionMaxAgeMs: 0 });
      await fresh.load("school-portal" as SourceTypeId);
      expect(fetching).toHaveBeenCalledTimes(3);
    } finally {
      fetching.mockRestore();
      await closed(server);
    }
  });

  it("calls its plugin for each of them", async () => {
    const server = await servePlugin(plugin, { host: "127.0.0.1" });
    try {
      const { sourceType } = await loadedFrom(server);

      expect(sourceType.setupSteps).toEqual([{ id: "pair", title: "Pair", description: "Scan the code.", live: true }]);
      expect(await sourceType.migrateConfig({ a: 1 }, 1)).toEqual({ a: 1 });
      expect(await sourceType.sourceAdded(context)).toEqual({ ok: true, plain: { account: "for https://portal.example.org" }, secrets: { token: "issued" } });
      await sourceType.sourceRemoved(context);
      expect(removed).toEqual([{ url: "https://portal.example.org" }]);
      expect(await sourceType.choices("chats", context)).toEqual({ ok: true, value: [{ value: "chats", label: "Class 3b" }] });
      expect(await sourceType.catalogue?.entries()).toEqual({ ok: true, value: [{ id: "north", displayName: "North", description: "The north school", installed: true, riskNotice: null }] });
      expect(await sourceType.setupProgress("pair", context)).toEqual({ status: "waiting", qrCode: "QR", message: null });
      expect(await sourceType.setupProgress("done", context)).toEqual({ status: "done", message: null });
      expect(await sourceType.setupProgress("other", context)).toEqual({ status: "failed", message: "Pairing failed." });

      await closed(server);

      expect(await sourceType.sourceAdded(context)).toMatchObject({ ok: false });
      await sourceType.sourceRemoved(context);
      expect(await sourceType.choices("chats", context)).toMatchObject({ ok: false, message: expect.stringContaining("not reachable") as unknown });
      expect(await sourceType.catalogue?.entries()).toMatchObject({ ok: false, message: expect.stringContaining("not reachable") as unknown });
      expect(await sourceType.setupProgress("pair", context)).toMatchObject({ status: "failed" });
    } finally {
      if (server.listening) await closed(server);
    }
  });

  it("migrates a configuration one version at a time, failing where its plugin fails", async () => {
    const migrating: PluginImplementation = {
      ...base,
      description: { ...base.description, configuration: { ...base.description.configuration, version: 3 } },
      configMigration: ({ fromVersion, plain }) => {
        if (plain.broken === true) throw new PluginError("definite", "Cannot read the old address.");
        return { plain: { ...plain, [`v${fromVersion + 1}`]: true } };
      },
    };
    const server = await servePlugin(migrating, { host: "127.0.0.1" });
    try {
      const { sourceType } = await loadedFrom(server);

      expect(await sourceType.migrateConfig({ url: "x" }, 1)).toEqual({ url: "x", v2: true, v3: true });
      expect(await sourceType.migrateConfig({ url: "x" }, 3)).toEqual({ url: "x" });
      await expect(sourceType.migrateConfig({ broken: true }, 2)).rejects.toThrow("from version 2 failed: Cannot read the old address.");
    } finally {
      await closed(server);
    }
  });

  it("reports why its plugin could not offer choices or catalogue entries", async () => {
    const failing: PluginImplementation = {
      ...plugin,
      fieldChoices: () => {
        throw new PluginError("definite", "The account is signed out.");
      },
      catalogueEntries: () => {
        throw new PluginError("temporary", "The bridge is restarting.");
      },
    };
    const server = await servePlugin(failing, { host: "127.0.0.1" });
    try {
      const { sourceType } = await loadedFrom(server);

      expect(await sourceType.choices("chats", context)).toEqual({ ok: false, message: "The account is signed out." });
      expect(await sourceType.catalogue?.entries()).toEqual({ ok: false, message: "The bridge is restarting." });
    } finally {
      await closed(server);
    }
  });

  it("does not send its plugin an invalid request", async () => {
    const server = await servePlugin(plugin, { host: "127.0.0.1" });
    try {
      const { sourceType } = await loadedFrom(server);

      const progress = await sourceType.setupProgress("", context);
      expect(progress.status).toBe("failed");
      expect(progress.message).toContain("asked the plugin");
    } finally {
      await closed(server);
    }
  });

  it("does without the optional ones its plugin lacks", async () => {
    const server = await servePlugin(base, { host: "127.0.0.1" });
    try {
      const { containers, sourceType } = await loadedFrom(server);

      expect(await sourceType.sourceAdded(context)).toEqual({ ok: true, plain: {}, secrets: {} });
      await sourceType.sourceRemoved(context);
      expect(await containers.load("other" as SourceTypeId)).toEqual({ ok: false });
    } finally {
      await closed(server);
    }
  });
});

describe("The Source wizard of a Source Type whose plugin runs in a container", () => {
  let instance: TestInstance;
  let server: Server;
  let failing: boolean;

  beforeEach(async () => {
    failing = false;
    const base = fakePlugin({ runs: [], poll: () => Promise.resolve({ sourceRecords: [], syncCursor: null }) });
    const plugin: PluginImplementation = {
      ...base,
      description: {
        ...base.description,
        configuration: {
          version: 2,
          fields: [
            { key: "school", label: "School", secret: false, required: true, hasChoices: false },
            { key: "classes", label: "Classes", secret: false, required: false, hasChoices: true },
          ],
        },
        catalogue: { title: "Schools", configKey: "school" },
      },
      fieldChoices: () => {
        if (failing) throw new PluginError("definite", "The account is signed out.");
        return { choices: [{ value: "3b", label: "Class 3b" }] };
      },
      catalogueEntries: () => {
        if (failing) throw new PluginError("temporary", "The portal is down.");
        return { entries: [{ id: "north", displayName: "North", description: "The north school", installed: true }] };
      },
      configMigration: ({ plain }) => {
        if (failing) throw new PluginError("definite", "The old campus is unknown.");
        return { plain: { ...plain, school: plain.campus, campus: null } };
      },
    };
    server = await servePlugin(plugin, { host: "127.0.0.1" });
    instance = await bootForTest({ pluginContainers: [{ sourceTypeId: "school-portal" as SourceTypeId, url: urlOf(server) }] });
    expect(await instance.app.sourceTypes.enable("school-portal")).toEqual({ ok: true });
    expect((await instance.app.catalogues.list())[0]).toMatchObject({ problem: null, entries: [{ id: "north" }] });
    expect(await instance.app.catalogues.enable("school-portal", "north")).toEqual({ ok: true });
  });
  afterEach(async () => {
    await instance.close();
    await closed(server);
  });

  const added = async () => {
    const result = await instance.app.sources.add({ sourceTypeId: "school-portal", plain: { school: "north" }, secrets: {} });
    if (!result.ok) throw new Error(`adding failed: ${result.problem}`);
    return result.id;
  };

  it("creates and edits a Source with the choices its plugin offers", async () => {
    const id = await added();

    expect(await instance.app.sources.find(id)).toMatchObject({ choices: { classes: { ok: true, value: [{ value: "3b", label: "Class 3b" }] } } });
    expect(await instance.app.sources.edit(id, { plain: { school: "north", classes: ["3b"] }, secrets: {} })).toMatchObject({ ok: true });
    expect((await instance.app.sources.find(id))?.plain).toMatchObject({ classes: ["3b"] });
  });

  it("tells why its plugin could not offer choices or Catalogue entries", async () => {
    const id = await added();
    failing = true;
    // Past the entries kept from adding the Source.
    instance.clock.advance(10_000);

    expect(await instance.app.sources.find(id)).toMatchObject({ choices: { classes: { ok: false, message: "The account is signed out." } } });
    expect((await instance.app.catalogues.list())[0]).toMatchObject({ problem: "The portal is down.", entries: [] });

    failing = false;
    instance.clock.advance(5_000);
    expect((await instance.app.catalogues.list())[0]?.entries, "an entry stays enabled through the outage").toMatchObject([{ id: "north", enabled: true }]);
  });

  it("migrates the configuration of its Sources over REST when it is enabled", async () => {
    const id = await added();
    await instance.query(`update source set config = '{"campus":"north"}', config_version = 1 where id = '${id}'`);
    await instance.query(`update source_type set enabled = false where id = 'school-portal'`);

    expect(await instance.app.sourceTypes.enable("school-portal")).toEqual({ ok: true });

    expect((await instance.app.sources.find(id))?.plain).toMatchObject({ school: "north", campus: null });
    expect(await instance.query(`select config_version from source where id = '${id}'`)).toEqual([{ config_version: 2 }]);
  });

  it("shows on a Source why its plugin could not migrate its configuration", async () => {
    const id = await added();
    await instance.query(`update source set config = '{"campus":"north"}', config_version = 1 where id = '${id}'`);
    await instance.query(`update source_type set enabled = false where id = 'school-portal'`);
    failing = true;

    expect(await instance.app.sourceTypes.enable("school-portal")).toEqual({ ok: true });

    const source = await instance.app.sources.find(id);
    expect(source?.plain).toEqual({ campus: "north" });
    expect(source?.health.problem).toEqual({ kind: "run-failed", message: expect.stringContaining("The old campus is unknown.") as unknown });
  });
});
