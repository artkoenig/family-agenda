import type { AddressInfo, Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPluginHandler, servePlugin } from "@family-agenda/plugin-kit/server";
import { contractProblems, pluginClient } from "@family-agenda/plugin-kit/testing";
import { describePluginContract } from "@family-agenda/plugin-kit/vitest";
import { demoAttributes } from "../src";
import { demoPlugin } from "../src/plugin";

const config = { plain: {}, secrets: {} };
const now = new Date("2026-09-14T07:00:00Z");

describePluginContract(() => createPluginHandler(demoPlugin), { config, now, languages: ["de"] });

describe("the demo Source over HTTP", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = await servePlugin(demoPlugin, { host: "127.0.0.1" });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("passes the contract tests by its URL", async () => {
    expect(await contractProblems(url, { config, now, languages: ["de"] })).toEqual([]);
  });

  it("states Items under the Source Attributes it declares", async () => {
    const answer = await pluginClient(url)("poll", { config, syncCursor: null, now: now.toISOString(), timeZone: "Europe/Berlin" });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ attributes: { declared: [...demoAttributes] }, syncCursor: null });
    expect((answer.body as { sourceRecords: unknown[] }).sourceRecords.length).toBeGreaterThan(0);
  });
});
