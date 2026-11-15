import type { AddressInfo } from "node:net";
import { servePlugin } from "@family-agenda/plugin-kit/server";
import type { SourceTypeId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyTicket } from "../../src/egress/ticket";
import { PluginContainers } from "../../src/plugin-containers/registry";
import { bootForTest, type OtherFamily, type TestInstance } from "../support/boot";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";

describe("two Families in one process", () => {
  let instance: TestInstance;
  let other: OtherFamily;
  beforeEach(async () => {
    instance = await bootForTest();
    other = await instance.bootOtherFamily();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("gives each its own database, sharing the plugin bindings", async () => {
    expect(other.app.familyId).not.toBe(instance.app.familyId);

    await instance.app.familyMembers.add({ name: "Mia" });

    expect((await instance.app.familyMembers.list()).map((member) => member.name)).toEqual(["Mia"]);
    expect(await other.app.familyMembers.list()).toEqual([]);
    expect(await other.query("select name from family_member")).toEqual([]);
  });

  it("never gives one Family an answer cached for another", async () => {
    const asked: string[] = [];
    const answerFor = (family: string) => () => {
      asked.push(family);
      return Promise.resolve(family);
    };

    expect(await instance.app.cached("catalogue", 60_000, 1_000, answerFor("first"))).toBe("first");
    expect(await other.app.cached("catalogue", 60_000, 1_000, answerFor("second"))).toBe("second");
    expect(await instance.app.cached("catalogue", 60_000, 1_000, answerFor("first again"))).toBe("first");
    expect(asked).toEqual(["first", "second"]);
  });
});

describe("two Families in one core over HTTP", () => {
  let instance: HttpTestInstance;
  beforeEach(async () => {
    instance = await bootHttpForTest();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("serves each Family from its own database", async () => {
    const other = await instance.bootHttpOtherFamily();

    const created = await instance.post("/setup", { email: "anna@example.org", password: "correct horse battery" });
    expect(created.status).toBe(303);

    expect((await instance.get("/setup")).status).toBe(404);
    expect((await other.get("/setup")).status).toBe(200);
  });
});

describe("the plugin bindings a process shares", () => {
  it("tickets each call for the Family it is made for", async () => {
    const ticketKey = "a-ticket-key-of-at-least-32-characters";
    const proxies: string[] = [];
    const server = await servePlugin(
      {
        description: {
          sourceTypeId: "school-portal",
          kind: "stateless",
          displayName: { en: "School portal" },
          version: "1.0.0",
          description: "Reads the school portal.",
          needsLlm: false,
          configuration: { version: 1, fields: [{ key: "url", label: "Address", secret: false, required: true, hasChoices: false }] },
          setupSteps: [],
          ingestion: { mode: "polling", suggestedIntervalSeconds: 600 },
          silentApplies: false,
          catalogue: { title: "Portals", configKey: "url" },
        },
        poll: () => ({}) as never,
        catalogueEntries: ({ egressProxy }) => {
          proxies.push(egressProxy);
          return { entries: [] };
        },
      },
      { host: "127.0.0.1" },
    );
    try {
      const shared = await PluginContainers.connect(
        [{ sourceTypeId: "school-portal" as SourceTypeId, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }],
        { ticketing: { ticketKey, familyId: "unknown" } },
      );
      for (const familyId of ["family-a", "family-b"]) {
        const loaded = await shared.forFamily(familyId).load("school-portal" as SourceTypeId);
        if (!loaded.ok) throw new Error("not loaded");
        await loaded.sourceType.catalogue?.entries();
      }

      const familiesOf = proxies.map((proxy) => verifyTicket(ticketKey, decodeURIComponent(new URL(proxy).password), Date.now())?.familyId);
      expect(familiesOf).toEqual(["family-a", "family-b"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
