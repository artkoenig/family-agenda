import type { SourceTypeId } from "@family-agenda/domain";
import { describe, expect, it } from "vitest";
import { CachedTimeout, createCache } from "../src/cached";
import { createCatalogueAccess } from "../src/catalogues";
import type { CatalogueEntrySpec, CatalogueRecord, LoadedSourceType, PluginAnswer, SourceTypeRegistry } from "../src/ports";

const entry = (id: string): CatalogueEntrySpec => ({ id, displayName: id, description: id, installed: true, riskNotice: null });

/** A catalogue plugin whose entries `answer` gives, counting how often it was asked; and one other Source Type with a catalogue. */
function setUp(answer: () => Promise<PluginAnswer<CatalogueEntrySpec[]>>) {
  const asked = new Map<string, number>();
  const sourceTypeOf = (id: string) =>
    ({
      catalogue: {
        title: "Networks",
        configKey: "messenger",
        entries: () => {
          asked.set(id, (asked.get(id) ?? 0) + 1);
          return answer();
        },
      },
    }) as unknown as LoadedSourceType;
  const registry: SourceTypeRegistry = {
    installed: () => [{ id: "bridged" }, { id: "other" }] as unknown as ReturnType<SourceTypeRegistry["installed"]>,
    load: (id) => Promise.resolve({ ok: true, sourceType: sourceTypeOf(id) }),
  };
  const records = new Map<string, CatalogueRecord[]>();
  const recordsOf = (sourceTypeId: string) => records.get(sourceTypeId) ?? records.set(sourceTypeId, []).get(sourceTypeId) ?? [];
  const access = createCatalogueAccess({
    cached: createCache({ now: () => new Date(0) }),
    registry,
    sourceTypes: {
      recordDiscovered: () => Promise.resolve(),
      list: () => Promise.resolve([{ id: "bridged" as SourceTypeId, enabled: true }, { id: "other" as SourceTypeId, enabled: true }]),
      enable: () => Promise.resolve(),
      disableIfUnused: () => Promise.resolve(true),
    },
    catalogues: {
      recordDiscovered: (sourceTypeId, ids) => {
        const known = recordsOf(sourceTypeId);
        for (const entryId of ids) if (!known.some((record) => record.entryId === entryId)) known.push({ entryId, enabled: false, pollIntervalSeconds: null });
        return Promise.resolve();
      },
      list: (sourceTypeId) => Promise.resolve([...recordsOf(sourceTypeId)]),
      enable: (sourceTypeId, entryId) => {
        const record = recordsOf(sourceTypeId).find((candidate) => candidate.entryId === entryId);
        if (record) record.enabled = true;
        return Promise.resolve();
      },
      setPollInterval: () => Promise.resolve(),
      disableIfUnused: () => Promise.resolve(true),
    },
  });
  return { access, asked: (id: string) => asked.get(id) ?? 0 };
}

describe("The catalogues of the Source Types", () => {
  it("decides on an entry the plugin lists now, not on the entries a page was shown", async () => {
    let entries = [entry("whatsapp")];
    const { access } = setUp(() => Promise.resolve({ ok: true, value: entries }));
    await access.of("bridged");
    entries = [entry("whatsapp"), entry("signal")];
    expect(await access.enable("bridged", "signal")).toEqual({ ok: true });
    expect(await access.setPollInterval("bridged", "signal", 3600)).toEqual({ ok: true });
  });

  it("tells a plugin that does not answer in time, or throws, as failing to list them, also at startup", async () => {
    const { access } = setUp(() => Promise.reject(new CachedTimeout("catalogue:bridged", 30_000)));
    await expect(access.start()).resolves.toBeUndefined();
    expect((await access.of("bridged"))?.problem).toBe("No answer for catalogue:bridged within 30000 ms.");
    const throwing = setUp(() => Promise.reject(new Error("boom")));
    expect((await throwing.access.of("bridged"))?.problem).toBe("boom");
    expect(await throwing.access.enable("bridged", "whatsapp")).toEqual({ ok: false, problem: "unknown-entry" });
  });

  it("asks only the plugin of the Source Type whose catalogue is opened", async () => {
    const { access, asked } = setUp(() => Promise.resolve({ ok: true, value: [entry("whatsapp")] }));
    await access.of("bridged");
    expect(asked("other")).toBe(0);
    expect(await access.of("unknown")).toBeNull();
    expect([...(await access.recordedEntryIds("bridged"))]).toEqual(["whatsapp"]);
  });
});
