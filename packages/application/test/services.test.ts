import { describe, expect, it } from "vitest";
import type { SourceTypeId } from "@family-agenda/domain";
import { createServiceSupervision } from "../src/services";
import type { CatalogueRepository, SourceTypeRegistry, SourceTypeRepository } from "../src/ports";

const bridged = "bridged" as SourceTypeId;
const plain = "plain" as SourceTypeId;

/** A Source Type with services, one without, and what the services were told. */
function supervised() {
  const enabled = new Set<SourceTypeId>();
  const entries: string[] = [];
  const told: { enabled: boolean; entries: string[] }[] = [];
  const state = { failNext: false, stopped: 0 };
  const services = {
    reconcile: (spec: { enabled: boolean; entries: string[] }) => {
      told.push(spec);
      if (!state.failNext) return Promise.resolve();
      state.failNext = false;
      return Promise.reject(new Error("the homeserver did not start"));
    },
    stop: () => {
      state.stopped += 1;
      return Promise.reject(new Error("already gone"));
    },
  };
  const registry = {
    installed: () => [{ id: bridged }, { id: plain }],
    load: (id: SourceTypeId) => Promise.resolve({ ok: true, sourceType: { services: id === bridged ? services : null } }),
  } as unknown as SourceTypeRegistry;
  const sourceTypes = { list: () => Promise.resolve([bridged, plain].map((id) => ({ id, enabled: enabled.has(id) }))) } as unknown as SourceTypeRepository;
  const catalogues = { list: () => Promise.resolve(["whatsapp", "signal"].map((entryId) => ({ entryId, enabled: entries.includes(entryId) }))) } as unknown as CatalogueRepository;
  return { supervision: createServiceSupervision({ registry, sourceTypes, catalogues }), enabled, entries, told, state };
}

describe("the services of Source Types", () => {
  it("are started as their Source Type is enabled, given the enabled entries, and told once it is disabled", async () => {
    const { supervision, enabled, entries, told } = supervised();

    await supervision.reconcile();
    expect(told).toEqual([]);

    enabled.add(bridged);
    enabled.add(plain);
    await supervision.reconcile();
    expect(told.at(-1)).toEqual({ enabled: true, entries: [] });

    entries.push("whatsapp");
    await supervision.reconcile();
    expect(told.at(-1)).toEqual({ enabled: true, entries: ["whatsapp"] });

    enabled.delete(bridged);
    await supervision.reconcile();
    expect(told.at(-1)).toEqual({ enabled: false, entries: [] });

    const count = told.length;
    await supervision.reconcile();
    expect(told).toHaveLength(count);
  });

  it("report a failure to reconcile, and are tried again", async () => {
    const { supervision, enabled, told, state } = supervised();
    enabled.add(bridged);
    state.failNext = true;

    expect(await supervision.reconcile()).toEqual({ failed: [{ sourceTypeId: bridged, message: "the homeserver did not start" }] });
    expect(await supervision.reconcile()).toEqual({ failed: [] });
    expect(told).toHaveLength(2);
  });

  it("are stopped as the worker shuts down, even should stopping fail", async () => {
    const { supervision, enabled, state } = supervised();
    enabled.add(bridged);
    await supervision.reconcile();

    await supervision.stop();
    await supervision.stop();

    expect(state.stopped).toBe(1);
  });
});
