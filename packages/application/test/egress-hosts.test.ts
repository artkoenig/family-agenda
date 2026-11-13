import type { SourceId, SourceTypeId } from "@family-agenda/domain";
import { describe, expect, it } from "vitest";
import { createEgressHosts, hostsOfSource } from "../src/egress-hosts";
import type { ConfigFieldSpec, LoadedSourceType, Source, SourceRepository, SourceTypeRegistry } from "../src/ports";

const imap = "imap" as SourceTypeId;

function field(key: string, flags: Partial<ConfigFieldSpec> = {}): ConfigFieldSpec {
  return { key, label: { en: key }, secret: false, required: false, description: null, setByPlugin: false, choice: false, host: false, ...flags };
}

const fields = [field("host", { host: true }), field("relay", { host: true }), field("token", { host: true, secret: true }), field("username")];

function registryWith(loadable: boolean): SourceTypeRegistry {
  return {
    installed: () => [],
    load: (id) =>
      Promise.resolve(loadable && id === imap ? { ok: true, sourceType: { configuration: { version: 1, fields } } as unknown as LoadedSourceType } : { ok: false }),
  };
}

const stored = { "source-1": imap, "source-2": imap } as Record<string, SourceTypeId>;

function sourcesWith(plains: Record<string, unknown>[], secretHosts: Record<string, string>[] = []): SourceRepository {
  return {
    findById: (id: SourceId) => {
      const index = Object.keys(stored).indexOf(id);
      const sourceTypeId = stored[id];
      return Promise.resolve(sourceTypeId === undefined ? null : ({ id, sourceTypeId, plain: plains[index] ?? {}, secretHosts: secretHosts[index] ?? {} } as Source));
    },
  } as unknown as SourceRepository;
}

const first = "source-1" as SourceId;
const second = "source-2" as SourceId;

describe("the egress hosts of a Source", () => {
  it("lists the values of its own plain host fields, once each, not those of other Sources of its type", async () => {
    const egressHosts = createEgressHosts({
      registry: registryWith(true),
      sources: sourcesWith([
        { host: " imap.gmx.net ", relay: "imap.gmx.net", token: "secret.example", username: "user.example" },
        { host: "other.example", relay: "relay.example:25" },
      ]),
    });

    expect(await egressHosts.ofSource(first, imap)).toEqual(["imap.gmx.net"]);
    expect(await egressHosts.ofSource(second, imap)).toEqual(["other.example", "relay.example:25"]);
  });

  it("skips empty and non-text values", async () => {
    const egressHosts = createEgressHosts({ registry: registryWith(true), sources: sourcesWith([{ host: 993, relay: "   " }]) });

    expect(await egressHosts.ofSource(first, imap)).toEqual([]);
  });

  it("lists the hosts kept in the clear of its secret host fields, not the plain values under their keys", async () => {
    const egressHosts = createEgressHosts({
      registry: registryWith(true),
      sources: sourcesWith([{ token: "plain.example" }], [{ token: "calendar.google.com", username: "user.example" }]),
    });

    expect(await egressHosts.ofSource(first, imap)).toEqual(["calendar.google.com"]);
  });

  it("knows no Source that is not stored, or of another Source Type", async () => {
    const egressHosts = createEgressHosts({ registry: registryWith(true), sources: sourcesWith([{ host: "imap.gmx.net" }]) });

    expect(await egressHosts.ofSource("source-3" as SourceId, imap)).toBeNull();
    expect(await egressHosts.ofSource(first, "ics" as SourceTypeId)).toBeNull();
  });

  it("lists none for a Source whose Source Type cannot be loaded", async () => {
    const egressHosts = createEgressHosts({ registry: registryWith(false), sources: sourcesWith([{ host: "imap.gmx.net" }]) });

    expect(await egressHosts.ofSource(first, imap)).toEqual([]);
  });
});

describe("hostsOfSource", () => {
  it("lists the host field values of a Source that is not stored yet", () => {
    expect(hostsOfSource(fields, { plain: { host: "imap.gmx.net", username: "u.example" }, secretHosts: { token: "cal.example" } })).toEqual(["imap.gmx.net", "cal.example"]);
  });
});
