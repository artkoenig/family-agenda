import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceId } from "@family-agenda/domain";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemorySecretStore } from "../support/in-memory-secret-store";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";

const whatsapp = {
  id: "whatsapp",
  displayName: "WhatsApp",
  description: "Reads WhatsApp.",
  installed: true,
  riskNotice: "Against WhatsApp's terms of service.",
};
const signal = { id: "signal", displayName: "Signal", description: "Reads Signal.", installed: false };

/** A Source Type whose Sources each use one network of its catalogue, with an account the plugin creates. */
const configuration = `{
  version: 1,
  fields: [
    { key: "network", label: "Network", secret: false, required: true },
    { key: "chats", label: "Chats", secret: false, required: false, choices: () => Promise.resolve([]) },
    { key: "account", label: "Account", secret: false, required: true, setByPlugin: true },
    { key: "token", label: "Token", secret: true, required: true, setByPlugin: true },
  ],
}`;

describe("a Source Type's catalogue and the Sources that use it", () => {
  let instance: TestInstance;
  let secrets: InMemorySecretStore;
  beforeEach(async () => {
    testPluginControls.catalogue("bridged", [whatsapp, signal]);
    secrets = new InMemorySecretStore();
    instance = await bootForTest({ secretStore: secrets });
    await writeTestPluginPackage(instance.workspacePackages, {
      sourceTypeId: "bridged",
      configuration,
      catalogue: { configKey: "network" },
      liveSteps: ["login"],
    });
    await instance.restart();
    await instance.app.sourceTypes.enable("bridged");
  });
  afterEach(async () => {
    await instance.close();
  });

  const entries = async () =>
    (await instance.app.catalogues.list())[0]?.entries.map(({ id, installed, enabled }) => ({ id, installed, enabled }));

  const addWhatsApp = async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    const added = await instance.app.sources.add({ sourceTypeId: "bridged", plain: { network: "whatsapp" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    return added;
  };

  it("lists the installed entries and the others, none enabled", async () => {
    expect(await entries()).toEqual([
      { id: "signal", installed: false, enabled: false },
      { id: "whatsapp", installed: true, enabled: false },
    ]);
  });

  it("enables an entry with a risk notice only once it is acknowledged, and never one not installed", async () => {
    expect(await instance.app.catalogues.enable("bridged", "whatsapp")).toEqual({ ok: false, problem: "risk-not-acknowledged" });
    expect(await instance.app.catalogues.enable("bridged", "signal")).toEqual({ ok: false, problem: "not-installed" });
    expect(await instance.app.catalogues.enable("bridged", "telegram")).toEqual({ ok: false, problem: "unknown-entry" });

    expect(await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true })).toEqual({ ok: true });

    expect(await entries()).toContainEqual({ id: "whatsapp", installed: true, enabled: true });
  });

  it("keeps an entry new after an update disabled", async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    testPluginControls.catalogue("bridged", [whatsapp, { ...signal, installed: true }, { ...signal, id: "telegram", displayName: "Telegram" }]);

    await instance.restart({ applicationVersion: "1.1.0" });

    const list = (await instance.app.catalogues.list())[0]?.entries;
    expect(list?.map(({ id, enabled, firstSeenIn }) => ({ id, enabled, firstSeenIn }))).toEqual([
      { id: "signal", enabled: false, firstSeenIn: "1.0.0" },
      { id: "telegram", enabled: false, firstSeenIn: "1.1.0" },
      { id: "whatsapp", enabled: true, firstSeenIn: "1.0.0" },
    ]);
  });

  it("offers only enabled, installed entries when adding a Source, and refuses others", async () => {
    const form = async () => (await instance.app.sources.forms())[0];
    expect((await form())?.catalogue).toEqual({ configKey: "network", entries: [] });
    expect(await instance.app.sources.add({ sourceTypeId: "bridged", plain: { network: "whatsapp" }, secrets: {} })).toEqual({
      ok: false,
      problem: "invalid-config",
      fields: ["network"],
    });

    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });

    expect((await form())?.catalogue?.entries).toEqual([{ id: "whatsapp", displayName: "WhatsApp" }]);
    expect((await form())?.fields.map((field) => field.key)).toEqual(["network", "chats"]);
  });

  it("refuses to disable an entry while a Source uses it", async () => {
    const { id } = await addWhatsApp();

    expect(await instance.app.catalogues.disable("bridged", "whatsapp")).toEqual({ ok: false, problem: "entry-in-use" });

    await instance.app.sources.remove(id);
    expect(await instance.app.catalogues.disable("bridged", "whatsapp")).toEqual({ ok: true });
    expect(await entries()).toContainEqual({ id: "whatsapp", installed: true, enabled: false });
  });

  it("stores what the plugin sets up for a new Source, its secrets in the SecretStore, and keeps them on edits", async () => {
    const added = await addWhatsApp();
    expect(added.setUp).toBe(true);

    const [source] = await instance.app.sources.list();
    expect(source?.plain).toMatchObject({ network: "whatsapp", account: expect.stringMatching(/^account-\d+$/) as unknown });
    expect(source?.storedSecrets).toEqual(["token"]);
    const [run] = await instance.query("SELECT secret_refs FROM sources");
    const ref = (run?.secret_refs as Record<string, string>).token!;
    expect(await secrets.get(ref as never)).toMatch(/^token-\d+$/);

    const edited = await instance.app.sources.edit(added.id, { plain: { network: "signal", chats: ["!a"] }, secrets: {} });
    expect(edited).toEqual({ ok: true });
    const [after] = await instance.app.sources.list();
    expect(after?.plain).toEqual({ network: "whatsapp", chats: ["!a"], account: source?.plain.account });
    expect(after?.storedSecrets).toEqual(["token"]);
  });

  it("refuses values an Admin gives for fields the plugin sets", async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });

    expect(
      await instance.app.sources.add({ sourceTypeId: "bridged", plain: { network: "whatsapp", account: "mine" }, secrets: {} }),
    ).toEqual({ ok: false, problem: "invalid-config", fields: ["account"] });
  });

  it("adds nothing when the plugin cannot prepare the Source", async () => {
    await instance.app.catalogues.enable("bridged", "whatsapp", { riskAcknowledged: true });
    testPluginControls.failAdding("bridged");

    expect(await instance.app.sources.add({ sourceTypeId: "bridged", plain: { network: "whatsapp" }, secrets: {} })).toEqual({
      ok: false,
      problem: "setup-failed",
      message: "the homeserver is unreachable",
    });
    expect(await instance.app.sources.list()).toEqual([]);
  });

  it("offers a choice field's values per Source and stores what was chosen as a list", async () => {
    const { id } = await addWhatsApp();
    testPluginControls.knowValues("bridged", [{ value: "!class:local", label: "Klasse 5b" }]);

    expect((await instance.app.sources.list())[0]?.choices).toEqual({ chats: [{ value: "!class:local", label: "Klasse 5b" }] });
    expect(await instance.app.sources.edit(id, { plain: { chats: "!class:local" }, secrets: {} })).toEqual({
      ok: false,
      problem: "invalid-config",
      fields: ["chats"],
    });
  });

  it("shows a live setup step's progress, such as a QR code", async () => {
    const { id } = await addWhatsApp();
    testPluginControls.setupShows("bridged", { status: "waiting", qrCode: "2@abc" });

    expect(await instance.app.sources.setupProgress(id, "login")).toEqual({ status: "waiting", qrCode: "2@abc", message: null });
    expect(await instance.app.sources.setupProgress(id, "unknown")).toBeNull();
    expect(await instance.app.sources.setupProgress("00000000-0000-4000-8000-000000000000" as SourceId, "login")).toBeNull();

    testPluginControls.setupShows("bridged", { status: "done" });
    expect(await instance.app.sources.setupProgress(id, "login")).toEqual({ status: "done", message: null });
  });

  it("lets the plugin clean up after a removed Source, with its secrets", async () => {
    const { id } = await addWhatsApp();
    const before = testPluginControls.removed("bridged").length;

    await instance.app.sources.remove(id);

    const removed = testPluginControls.removed("bridged");
    expect(removed).toHaveLength(before + 1);
    expect(removed.at(-1)?.config.secrets.token).toMatch(/^token-\d+$/);
  });
});
