import type { SourceTypeId } from "@family-agenda/domain";
import { describe, expect, it } from "vitest";
import { createEgressHosts } from "../src/egress-hosts";
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

function sourcesWith(plains: Record<string, unknown>[]): SourceRepository {
  return { listOfType: (id: SourceTypeId) => Promise.resolve(id === imap ? plains.map((plain) => ({ plain }) as Source) : []) } as unknown as SourceRepository;
}

describe("the egress hosts of a Source Type", () => {
  it("lists the values of its Sources' plain host fields, once each", async () => {
    const egressHosts = createEgressHosts({
      registry: registryWith(true),
      sources: sourcesWith([
        { host: " imap.gmx.net ", relay: "", token: "secret.example", username: "user.example" },
        { host: "imap.gmx.net", relay: "relay.example:25" },
        { host: 993, relay: "   " },
      ]),
    });

    expect(await egressHosts.ofSourceType(imap)).toEqual(["imap.gmx.net", "relay.example:25"]);
  });

  it("lists none for a Source Type that cannot be loaded", async () => {
    const egressHosts = createEgressHosts({ registry: registryWith(false), sources: sourcesWith([{ host: "imap.gmx.net" }]) });

    expect(await egressHosts.ofSourceType(imap)).toEqual([]);
  });
});
