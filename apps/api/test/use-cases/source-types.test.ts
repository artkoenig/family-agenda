import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import type { SourceId } from "@family-agenda/domain";
import {
  testPluginControls,
  writeTestPluginPackage,
  type TestPluginPackage,
} from "../support/test-source-plugin";

describe("Source Types", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
  });
  afterEach(async () => {
    await instance.close();
  });

  /** Publishes plugins and restarts, as an update bringing them would. */
  const installAndRestart = async (plugins: TestPluginPackage[]) => {
    for (const plugin of plugins) await writeTestPluginPackage(instance.publishedPlugins, plugin);
    await instance.restart();
  };

  const list = async () =>
    (await instance.app.sourceTypes.list()).map((type) => ({
      id: type.id,
      enabled: type.enabled,
      notLoadable: type.notLoadable,
    }));

  it("lists the Source Types the Plugin Host installed, none enabled", async () => {
    await writeTestPluginPackage(instance.publishedPlugins, {
      sourceTypeId: "school-portal",
      displayName: "School portal",
      description: "Reads the timetable.",
    });
    await writeTestPluginPackage(instance.publishedPlugins, {
      sourceTypeId: "club-mail",
      displayName: "Club mail",
      description: "Reads the club's mails.",
      needsLlm: true,
    });
    const other = join(instance.publishedPlugins, "domain");
    await mkdir(other);
    await writeFile(join(other, "package.json"), JSON.stringify({ name: "@family-agenda/domain" }));
    await instance.restart();

    const types = await instance.app.sourceTypes.list();
    expect(
      types.map(({ id, displayName, description, needsLlm, enabled }) => ({
        id, displayName, description, needsLlm, enabled,
      })),
    ).toEqual([
      { id: "club-mail", displayName: "Club mail", description: "Reads the club's mails.", needsLlm: true, enabled: false },
      { id: "school-portal", displayName: "School portal", description: "Reads the timetable.", needsLlm: false, enabled: false },
    ]);
  });

  it("loads only the plugins an Admin has enabled", async () => {
    await installAndRestart([{ sourceTypeId: "school-portal" }, { sourceTypeId: "club-mail" }]);

    expect(await instance.app.sourceTypes.enable("school-portal")).toEqual({ ok: true });

    expect(await list()).toEqual([
      { id: "club-mail", enabled: false, notLoadable: null },
      { id: "school-portal", enabled: true, notLoadable: null },
    ]);

    await instance.restart();
    expect((await list()).map((type) => [type.id, type.enabled])).toEqual([
      ["club-mail", false],
      ["school-portal", true],
    ]);
    expect(await instance.app.sourceTypes.enable("unknown")).toEqual({ ok: false, problem: "unknown-source-type" });
  });

  it("enables a Source Type with a risk notice only once it is acknowledged", async () => {
    await installAndRestart([{ sourceTypeId: "messenger", riskNotice: "Uses an unofficial client." }]);

    const [messenger] = await instance.app.sourceTypes.list();
    expect(messenger?.riskNotice).toBe("Uses an unofficial client.");
    expect(await instance.app.sourceTypes.enable("messenger")).toEqual({
      ok: false,
      problem: "risk-not-acknowledged",
    });

    expect(await instance.app.sourceTypes.enable("messenger", { riskAcknowledged: true })).toEqual({ ok: true });
    expect((await list())[0]?.enabled).toBe(true);
  });

  it("lists a plugin built for another SDK as not loadable, with the reason", async () => {
    await installAndRestart([{ sourceTypeId: "old-portal", sdkVersion: "9.0.0" }]);

    expect(await list()).toEqual([
      {
        id: "old-portal",
        enabled: false,
        notLoadable: "built for SDK 9.0.0, but this is SDK 2.0.0",
      },
    ]);
    expect(await instance.app.sourceTypes.enable("old-portal")).toEqual({ ok: false, problem: "not-loadable" });
  });

  it("lists Source Types an update brings as disabled, keeping the ones enabled before", async () => {
    await installAndRestart([{ sourceTypeId: "school-portal" }]);
    await instance.app.sourceTypes.enable("school-portal");

    await writeTestPluginPackage(instance.publishedPlugins, { sourceTypeId: "club-mail" });
    await installAndRestart([{ sourceTypeId: "calendar" }]);

    expect((await list()).map(({ id, enabled }) => [id, enabled])).toEqual([
      ["calendar", false],
      ["club-mail", false],
      ["school-portal", true],
    ]);
  });

  it("disables a Source Type only while it has no Sources", async () => {
    await installAndRestart([{ sourceTypeId: "school-portal" }]);
    await instance.app.sourceTypes.enable("school-portal");
    const added = await instance.app.sources.add({
      sourceTypeId: "school-portal",
      plain: { url: "https://school.example.org" },
      secrets: { password: "hunter2" },
    });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);

    expect(await instance.app.sourceTypes.disable("school-portal")).toEqual({ ok: false, problem: "has-sources" });

    await instance.app.sources.remove(added.id);
    expect(await instance.app.sourceTypes.disable("school-portal")).toEqual({ ok: true });
    expect((await list())[0]?.enabled).toBe(false);
    expect(await instance.app.sourceTypes.disable("school-portal")).toEqual({ ok: true });
    expect(await instance.app.sourceTypes.disable("unknown")).toEqual({ ok: false, problem: "unknown-source-type" });
  });
});

describe("Sources", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
    await writeTestPluginPackage(instance.publishedPlugins, { sourceTypeId: "school-portal" });
    await writeTestPluginPackage(instance.publishedPlugins, { sourceTypeId: "club-mail" });
    await instance.restart();
    await instance.app.sourceTypes.enable("school-portal");
  });
  afterEach(async () => {
    await instance.close();
  });

  it("keeps the plain configuration and puts secrets into the SecretStore", async () => {
    const added = await instance.app.sources.add({
      sourceTypeId: "school-portal",
      plain: { url: "https://school.example.org" },
      secrets: { password: "hunter2" },
    });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);

    expect(await instance.app.sources.list()).toEqual([
      {
        id: added.id,
        sourceTypeId: "school-portal",
        displayName: "school-portal",
        plain: { url: "https://school.example.org" },
        storedSecrets: ["password"],
        pollIntervalSeconds: null,
        shown: true,
        name: null,
        health: { status: "ok", problem: null, lastSuccessAt: null, invalidRecords: [], unknownAttributes: [] },
        attributes: [],
      },
    ]);
    const [row] = await instance.query(
      "SELECT config, secret_refs::text AS refs, sync_cursor FROM source JOIN source_run ON source_run.source_id = source.id",
    );
    expect(row?.config).toEqual({ url: "https://school.example.org" });
    expect(row?.refs).not.toContain("hunter2");
    expect(row?.sync_cursor).toBeNull();
  });

  it("are added only to an enabled Source Type, with every required field", async () => {
    expect(
      await instance.app.sources.add({ sourceTypeId: "club-mail", plain: { url: "x" }, secrets: {} }),
    ).toEqual({ ok: false, problem: "source-type-not-enabled" });
    expect(
      await instance.app.sources.add({ sourceTypeId: "school-portal", plain: {}, secrets: {} }),
    ).toEqual({ ok: false, problem: "invalid-config", fields: ["url"] });
    expect(
      await instance.app.sources.add({
        sourceTypeId: "school-portal",
        plain: { url: "x", colour: "red" },
        secrets: { url: "y" },
      }),
    ).toEqual({ ok: false, problem: "invalid-config", fields: ["colour", "url"] });
    expect(await instance.app.sources.list()).toEqual([]);
  });

  it("run the configuration migrations a plugin ships, at startup", async () => {
    const added = await instance.app.sources.add({
      sourceTypeId: "school-portal",
      plain: { url: "https://school.example.org" },
      secrets: {},
    });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);

    await writeTestPluginPackage(instance.publishedPlugins, {
      sourceTypeId: "school-portal",
      directory: "school-portal-v2",
      version: "2.0.0",
      configuration: `{
        version: 2,
        fields: [{ key: "address", label: "Address", secret: false, required: true }],
        migrations: { 1: (plain) => ({ address: plain.url }) },
      }`,
    });
    await rm(join(instance.publishedPlugins, "school-portal"), { recursive: true });
    await instance.restart();

    expect((await instance.app.sources.list()).map(({ id, plain }) => ({ id, plain }))).toEqual([
      { id: added.id, plain: { address: "https://school.example.org" } },
    ]);
    await instance.restart();
    expect((await instance.app.sources.list())[0]?.plain).toEqual({ address: "https://school.example.org" });
  });

  const add = async (input: { pollIntervalSeconds?: number | null } = {}) => {
    const added = await instance.app.sources.add({
      sourceTypeId: "school-portal",
      plain: { url: "https://school.example.org" },
      secrets: { password: "hunter2" },
      ...input,
    });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    return added.id;
  };

  /** What the plugin was run with last time. */
  const lastRun = () => {
    const run = testPluginControls.runs("school-portal").at(-1);
    return run && { config: run.config, syncCursor: run.syncCursor };
  };

  it("offers the enabled Source Types with the form their plugin declares", async () => {
    expect(await instance.app.sources.forms()).toEqual([
      {
        sourceTypeId: "school-portal",
        displayName: "school-portal",
        fields: [
          { key: "url", label: "URL", secret: false, required: true, description: null, setByPlugin: false, choice: false },
          { key: "password", label: "Password", secret: true, required: false, description: null, setByPlugin: false, choice: false },
        ],
        catalogue: null,
        setupSteps: [],
        suggestedIntervalSeconds: 600,
      },
    ]);
  });

  it("are edited, keeping a secret left empty and replacing one given anew", async () => {
    const id = await add();

    expect(
      await instance.app.sources.edit(id, { plain: { url: "https://new.example.org" }, secrets: { password: "" } }),
    ).toEqual({ ok: true });
    await instance.app.polling.pollDue();
    expect(lastRun()).toEqual({
      config: { plain: { url: "https://new.example.org" }, secrets: { password: "hunter2" } },
      syncCursor: null,
    });

    await instance.app.sources.edit(id, { plain: { url: "https://new.example.org" }, secrets: { password: "s3cret" } });
    instance.clock.advance(10 * 60 * 1000);
    await instance.app.polling.pollDue();
    expect(lastRun()).toEqual({
      config: { plain: { url: "https://new.example.org" }, secrets: { password: "s3cret" } },
      syncCursor: "1",
    });
  });

  it("refuses an edit that leaves out a required field or names an unknown Source", async () => {
    const id = await add();

    expect(await instance.app.sources.edit(id, { plain: {}, secrets: {} })).toEqual({
      ok: false,
      problem: "invalid-config",
      fields: ["url"],
    });
    expect(
      await instance.app.sources.edit("3f0b2a52-0000-4000-8000-000000000000" as SourceId, { plain: {}, secrets: {} }),
    ).toEqual({ ok: false, problem: "unknown-source" });
  });

  it("are polled on the interval an Admin sets, or on the plugin's suggestion", async () => {
    const id = await add({ pollIntervalSeconds: 60 * 60 });
    const runs = () => testPluginControls.runs("school-portal").length;
    const start = runs();

    await instance.app.polling.pollDue();
    instance.clock.advance(30 * 60 * 1000);
    await instance.app.polling.pollDue();
    expect(runs() - start).toBe(1);

    await instance.app.sources.edit(id, {
      plain: { url: "https://school.example.org" },
      secrets: {},
      pollIntervalSeconds: null,
    });
    await instance.app.polling.pollDue();
    expect(runs() - start).toBe(2);
    expect((await instance.app.sources.list())[0]?.pollIntervalSeconds).toBeNull();
  });

  it("refuse a polling interval under a minute or over a week", async () => {
    for (const pollIntervalSeconds of [30, 8 * 24 * 60 * 60, 90.5]) {
      expect(
        await instance.app.sources.add({
          sourceTypeId: "school-portal",
          plain: { url: "x" },
          secrets: {},
          pollIntervalSeconds,
        }),
      ).toEqual({ ok: false, problem: "invalid-interval" });
    }
  });
});
