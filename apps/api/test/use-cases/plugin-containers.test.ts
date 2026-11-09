import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { RunContext } from "@family-agenda/plugin-contract";
import { PluginError, type PluginImplementation } from "@family-agenda/plugin-kit";
import { servePlugin } from "@family-agenda/plugin-kit/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceTypeId } from "@family-agenda/domain";
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
      pluginContainerOptions: { timeoutsMs: { poll: 200 } },
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

  it("polls its Sources with the whole run context and keeps the sync cursor and the secrets it changed", async () => {
    state.poll = () => Promise.resolve({ sourceRecords: [evening], syncCursor: "cursor-1", attributes: { declared: [{ externalId: "main", name: "Class 3b" }], archived: [] }, secrets: { token: "second" } });

    const report = await poll();

    expect(report.failed).toEqual([]);
    expect(report.polled).toHaveLength(1);
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
  const description = { ...fakePlugin({ runs: [], poll: () => Promise.resolve({}) }).description, contractVersion: "1.0", endpoints: { sourceAdded: false, sourceRemoved: false } };

  it("is loadable for the bound Source Type and the core's contract", () => {
    expect(descriptionProblem(binding, description)).toBeNull();
  });

  it("is refused for a plugin contract the core does not implement", () => {
    expect(descriptionProblem(binding, { ...description, contractVersion: "2.0" })).toBe("built for plugin contract 2.0, but the core implements 1.0");
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

  it("calls its plugin for each of them", async () => {
    const server = await servePlugin(plugin, { host: "127.0.0.1" });
    try {
      const { sourceType } = await loadedFrom(server);

      expect(sourceType.setupSteps).toEqual([{ id: "pair", title: "Pair", description: "Scan the code.", live: true }]);
      expect(sourceType.migrateConfig({ a: 1 }, 1)).toEqual({ a: 1 });
      expect(() => sourceType.migrateConfig({}, 0)).toThrow("not supported");
      expect(await sourceType.sourceAdded(context)).toEqual({ ok: true, plain: { account: "for https://portal.example.org" }, secrets: { token: "issued" } });
      await sourceType.sourceRemoved(context);
      expect(removed).toEqual([{ url: "https://portal.example.org" }]);
      expect(await sourceType.choices("chats", context)).toEqual([{ value: "chats", label: "Class 3b" }]);
      expect(await sourceType.catalogue?.entries()).toEqual([{ id: "north", displayName: "North", description: "The north school", installed: true, riskNotice: null }]);
      expect(await sourceType.setupProgress("pair", context)).toEqual({ status: "waiting", qrCode: "QR", message: null });
      expect(await sourceType.setupProgress("done", context)).toEqual({ status: "done", message: null });
      expect(await sourceType.setupProgress("other", context)).toEqual({ status: "failed", message: "Pairing failed." });

      await closed(server);

      expect(await sourceType.sourceAdded(context)).toMatchObject({ ok: false });
      await sourceType.sourceRemoved(context);
      expect(await sourceType.choices("chats", context)).toEqual([]);
      expect(await sourceType.catalogue?.entries()).toEqual([]);
      expect(await sourceType.setupProgress("pair", context)).toMatchObject({ status: "failed" });
    } finally {
      if (server.listening) await closed(server);
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
