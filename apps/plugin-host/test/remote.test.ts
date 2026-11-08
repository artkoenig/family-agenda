import { readFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { describeSourcePluginContract } from "@family-agenda/source-sdk/testing";
import type { SourceTypeId } from "@family-agenda/domain";
import { bundlePlugin, PluginHostClient, SourceRegistry } from "@family-agenda/composition";
import { PluginManager } from "../src/manager";
import { createPluginHostServer } from "../src/server";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const token = "test-token";

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const manager = new PluginManager({ workDirectory: await realpath(await mkdtemp(join(tmpdir(), "plugin-host-remote-"))), firstUserId: null, memoryMb: 256, openFiles: 256, callTimeoutMs: 20_000 });
const host = createPluginHostServer(manager, token);
const url = await listen(host);

const ics = readFileSync(join(root, "packages/source-ics/test/fixtures/family-v1.ics"), "utf8");
const calendar = createServer((_, response) => response.writeHead(200, { "content-type": "text/calendar" }).end(ics));
const calendarUrl = `${await listen(calendar)}/basic.ics`;

afterAll(() => {
  manager.stop();
  host.close();
  calendar.close();
});

const remoteIcs = (await new PluginHostClient({ url, token }).hosted("ics", await bundlePlugin(join(root, "packages/source-ics/src/index.ts")))).plugin;

describe("the ICS plugin run by the Plugin Host", () => {
  describeSourcePluginContract(() => remoteIcs, { config: { plain: {}, secrets: { url: calendarUrl } }, now: new Date("2026-09-14T07:00:00Z"), languages: ["de"] });
});

describe("the Plugin Host channel", () => {
  it("refuses a wrong token", async () => {
    const response = await fetch(`${url}/plugins/ics/poll`, { method: "POST", body: "[]", headers: { authorization: "Bearer wrong" } });

    expect(response.status).toBe(401);
  });

  it("answers 404 for what it does not know", async () => {
    const headers = { authorization: `Bearer ${token}` };

    expect((await fetch(`${url}/plugins/missing/poll`, { method: "POST", body: "[]", headers })).status).toBe(404);
    expect((await fetch(`${url}/plugins/ics/unknown`, { method: "POST", body: "[]", headers })).status).toBe(404);
    expect((await fetch(`${url}/other`, { headers })).status).toBe(404);
  });

  it("passes a definite Source error back as one", async () => {
    if (remoteIcs.ingestion.mode !== "polling") throw new Error("polls");

    await expect(remoteIcs.ingestion.poll({ config: { plain: {}, secrets: { url: "ftp://nowhere" } }, syncCursor: null, now: new Date(), timeZone: "UTC" })).rejects.toMatchObject({
      name: "SourceError",
      kind: "definite",
    });
  });
});

describe("a registry with a Plugin Host", () => {
  it("polls the demo Source through the host, end to end, and the other Source Types in process", async () => {
    const registry = await SourceRegistry.discover([join(root, "packages"), join(root, "tools")], { pluginHost: { url, token, sourceTypes: ["demo", "ics"] } });

    const demo = await registry.load("demo" as SourceTypeId);
    const webuntis = await registry.load("webuntis" as SourceTypeId);
    if (!demo.ok || demo.sourceType.ingestion.mode !== "polling") throw new Error("the demo polls");
    const result = await demo.sourceType.ingestion.poll({ plain: {}, secrets: {}, syncCursor: null, now: new Date("2026-09-14T07:00:00Z"), timeZone: "Europe/Berlin" });

    expect(result).toMatchObject({ ok: true, declared: expect.arrayContaining([{ externalId: "family", name: "Family calendar" }]) as unknown });
    expect(result.ok && result.origins.length).toBeGreaterThan(10);
    expect(webuntis.ok).toBe(true);
    expect(registry.installed().find((type) => type.id === "demo")?.notLoadable).toBeNull();
  });

  it("refuses invalid Origins a hosted plugin returns", async () => {
    const client = new PluginHostClient({ url, token });
    const bundle = `export default { identity: { sourceTypeId: "bad", displayName: "Bad", version: "1", sdkVersion: "2.0.0" }, configuration: { version: 1, fields: [] }, setupSteps: [],
      ingestion: { mode: "polling", suggestedIntervalSeconds: 60, poll: async (c) => c.config.plain.shape ? { origins: [{ externalId: 1 }], syncCursor: null } : { origins: [], syncCursor: 5 } }, health: { silentApplies: false } };`;
    const { plugin } = await client.hosted("bad", bundle);
    if (plugin.ingestion.mode !== "polling") throw new Error("polls");
    const context = (plain: object) => ({ config: { plain: plain as never, secrets: {} }, syncCursor: null, now: new Date(), timeZone: "UTC" });

    await expect(plugin.ingestion.poll(context({ shape: true }))).rejects.toMatchObject({ kind: "definite", message: expect.stringContaining("Origin 0") as unknown });
    await expect(plugin.ingestion.poll(context({}))).rejects.toMatchObject({ kind: "definite", message: expect.stringContaining("sync cursor") as unknown });
  });

  it("installs a plugin again once the host lost it", async () => {
    const client = new PluginHostClient({ url, token });
    const bundle = await bundlePlugin(join(root, "tools/demo-source/src/index.ts"));
    const { plugin } = await client.hosted("demo", bundle);
    manager.stop();
    if (plugin.ingestion.mode !== "polling") throw new Error("polls");

    const result = await plugin.ingestion.poll({ config: { plain: {}, secrets: {} }, syncCursor: null, now: new Date(), timeZone: "UTC" });

    expect(result.origins.length).toBeGreaterThan(0);
  });
});
