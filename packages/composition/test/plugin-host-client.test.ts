import { describe, expect, it } from "vitest";
import { encode, type CallOutcome, type PluginDescription } from "@family-agenda/plugin-protocol";
import type { SourcePluginManifest } from "@family-agenda/source-sdk";
import { PluginHostClient } from "../src/plugin-host-client";

const description: PluginDescription = {
  identity: { sourceTypeId: "fake", displayName: "Fake", version: "1.0.0", sdkVersion: "2.0.0" },
  configuration: { version: 2, fields: [{ key: "a", label: "A", secret: false, required: false, choices: true }, { key: "b", label: "B", secret: false, required: false, choices: false }], migrations: [1] },
  setupSteps: [{ id: "live", title: "L", description: "L", live: true }, { id: "plain", title: "P", description: "P", live: false }],
  ingestion: { mode: "polling", suggestedIntervalSeconds: 60 },
  health: { silentApplies: false },
  catalogue: { title: "C", configKey: "a" },
  sourceAdded: true,
  sourceRemoved: true,
};

const manifest: SourcePluginManifest = { entry: "./index.ts", identity: description.identity, description: "Fake", needsLlm: false, esModule: true };

const context = { config: { plain: {}, secrets: {} }, syncCursor: null, now: new Date(), timeZone: "UTC" };

/** A host that answers each call with what `answers` gives for its name. */
function host(answers: Record<string, () => CallOutcome | Response>, described: PluginDescription = description) {
  const calls: string[] = [];
  const fetch = ((url: URL, init: RequestInit) => {
    const name = url.pathname.split("/")[3];
    calls.push(`${init.method} ${name ?? ""}`);
    if (name === undefined) return Promise.resolve(new Response(encode([{ manifest, description: described }])));
    const answer = answers[name]?.() ?? { ok: true, value: null };
    return Promise.resolve(answer instanceof Response ? answer : new Response(encode(answer)));
  }) as typeof globalThis.fetch;
  const client = new PluginHostClient({ url: "http://host", token: "t", fetch });
  const first = async () => {
    const [remote] = await client.available();
    if (!remote) throw new Error("the host offers a plugin");
    return remote.hosted;
  };
  return { client, first, calls, fetch };
}

const polled = (value: unknown) => host({ poll: () => ({ ok: true, value }) });

describe("a plugin the Plugin Host runs, as the core calls it", () => {
  it("calls the host for choices, live setup steps, the catalogue, added and removed Sources and migrations", async () => {
    const { first, calls } = host({
      choices: () => ({ ok: true, value: [{ value: "x", label: "X" }] }),
      catalogueEntries: () => ({ ok: true, value: [] }),
      sourceAdded: () => ({ ok: true, value: { plain: {}, secrets: {} } }),
      migrate: () => ({ ok: true, value: { migrated: true } }),
    });
    const hosted = await first();
    const { plugin } = hosted;

    expect(await plugin.configuration.fields[0]?.choices?.(context)).toEqual([{ value: "x", label: "X" }]);
    expect(plugin.configuration.fields[1]?.choices).toBeUndefined();
    expect(await plugin.setupSteps[0]?.progress?.(context)).toMatchObject({ status: "failed" });
    expect(plugin.setupSteps[1]?.progress).toBeUndefined();
    expect(await plugin.catalogue?.entries()).toEqual([]);
    expect(await plugin.sourceAdded?.(context)).toEqual({ plain: {}, secrets: {} });
    await plugin.sourceRemoved?.(context);
    expect(await hosted.migrate(1, {})).toEqual({ migrated: true });
    expect(() => plugin.configuration.migrations?.[1]?.({})).toThrow("asynchronously");
    expect(calls).toContain("POST sourceRemoved");
  });

  it("leaves out what the plugin does not have, and refuses pushes", async () => {
    const { first } = host({}, { ...description, ingestion: { mode: "push" }, catalogue: null, sourceAdded: false, sourceRemoved: false });
    const { plugin } = await first();

    expect(plugin.catalogue).toBeUndefined();
    expect("sourceAdded" in plugin).toBe(false);
    expect("sourceRemoved" in plugin).toBe(false);
    if (plugin.ingestion.mode !== "push") throw new Error("pushes");
    await expect(plugin.ingestion.receive({} as never, {} as never)).rejects.toThrow("cannot receive pushes");
  });

  it("is a temporary failure when the host lost the plugin", async () => {
    const { first } = host({ catalogueEntries: () => new Response(null, { status: 404 }) });
    const { plugin } = await first();

    await expect(plugin.catalogue?.entries()).rejects.toMatchObject({ kind: "temporary", message: expect.stringContaining('no plugin "fake"') as unknown });
  });

  it("turns failures into Source errors or plain errors", async () => {
    const { first } = host({
      poll: () => ({ ok: false, failure: { sourceError: "temporary", message: "later" } }),
      catalogueEntries: () => ({ ok: false, failure: { sourceError: null, message: "broken" } }),
      choices: () => new Response(null, { status: 502 }),
      sourceAdded: () => new Response(null, { status: 401 }),
      sourceRemoved: () => new Response(null, { status: 413 }),
    });
    const { plugin } = await first();
    if (plugin.ingestion.mode !== "polling") throw new Error("polls");

    await expect(plugin.ingestion.poll(context)).rejects.toMatchObject({ name: "SourceError", kind: "temporary", message: "later" });
    await expect(plugin.catalogue?.entries()).rejects.toMatchObject({ name: "Error", message: "broken" });
    await expect(plugin.configuration.fields[0]?.choices?.(context)).rejects.toMatchObject({ kind: "temporary", message: expect.stringContaining("502") as unknown });
    await expect(plugin.sourceAdded?.(context)).rejects.toThrow("refused the token");
    await expect(plugin.sourceRemoved?.(context)).rejects.toThrow('refused the call "sourceRemoved" with status 413');
  });

  it("asks a host that cannot be reached again, then gives up", async () => {
    let tries = 0;
    const unreachable = new PluginHostClient({ url: "http://host", token: "t", fetch: () => (tries++, Promise.reject(new Error("refused"))) });

    await expect(unreachable.available({ attempts: 3, delayMs: 1 })).rejects.toMatchObject({ kind: "temporary", message: expect.stringContaining("refused") as unknown });
    expect(tries).toBe(3);
  });

  it("lists the plugins a host offers with their manifests, once it answers", async () => {
    let tries = 0;
    const { fetch } = host({});
    const flaky = new PluginHostClient({ url: "http://host", token: "t", fetch: (url, init) => (tries++ === 0 ? Promise.reject(new Error("starting")) : fetch(url, init)) });

    expect((await flaky.available({ attempts: 2, delayMs: 1 })).map((remote) => remote.manifest)).toEqual([manifest]);
  });

  it.each([
    ["no object", 5, "it is no object"],
    ["no origin list", { origins: 1, syncCursor: null }, "its origins are no list"],
    ["a cursor of no text", { origins: [], syncCursor: 1 }, "its sync cursor is no text"],
    ["lists of no list", { origins: [], syncCursor: null, withdrawn: 1 }, "its withdrawn are no list"],
    ["an Origin of no object", { origins: [1], syncCursor: null }, "Origin 0: it is no object"],
    ["no external id", { origins: [{ attributes: [], content: { kind: "raw-message", text: "", attachments: [] } }], syncCursor: null }, "external id"],
    ["no attribute list", { origins: [{ externalId: "o", attributes: [1], content: { kind: "raw-message", text: "", attachments: [] } }], syncCursor: null }, "Source Attributes"],
    ["a subject of no text", { origins: [{ externalId: "o", attributes: [], subject: 1, content: { kind: "raw-message", text: "", attachments: [] } }], syncCursor: null }, "its subject is no text"],
    ["a time of no date", { origins: [{ externalId: "o", attributes: [], occurredAt: "now", content: { kind: "raw-message", text: "", attachments: [] } }], syncCursor: null }, "its time is no date"],
    ["no content", { origins: [{ externalId: "o", attributes: [] }], syncCursor: null }, "it has no content"],
    ["an unknown content", { origins: [{ externalId: "o", attributes: [], content: { kind: "x" } }], syncCursor: null }, "no known kind"],
    ["an unknown stated kind", { origins: [{ externalId: "o", attributes: [], content: { kind: "stated", stated: { kind: "x" } } }], syncCursor: null }, "states no known kind"],
    ["a text of no text", { origins: [{ externalId: "o", attributes: [], content: { kind: "raw-message", text: 1, attachments: [] } }], syncCursor: null }, "its text is no text"],
    ["invalid attachments", { origins: [{ externalId: "o", attributes: [], content: { kind: "raw-message", text: "", attachments: [{ filename: "f", contentType: "x", bytes: "b" }] } }], syncCursor: null }, "attachments are invalid"],
  ])("refuses a poll result with %s", async (_, value, problem) => {
    const { plugin } = await polled(value).first();
    if (plugin.ingestion.mode !== "polling") throw new Error("polls");

    await expect(plugin.ingestion.poll(context)).rejects.toMatchObject({ kind: "definite", message: expect.stringContaining(problem) as unknown });
  });

  it("passes a valid poll result on", async () => {
    const result = { origins: [{ externalId: "o", attributes: ["a"], occurredAt: new Date(), content: { kind: "raw-message", text: "t", attachments: [{ filename: "f", contentType: "x", bytes: new Uint8Array([1]) }] } }], syncCursor: "c", withdrawn: [] };
    const { plugin } = await polled(result).first();
    if (plugin.ingestion.mode !== "polling") throw new Error("polls");

    expect(await plugin.ingestion.poll(context)).toEqual(result);
  });
});
