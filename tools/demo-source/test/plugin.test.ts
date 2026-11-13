import type { AddressInfo, Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPluginHandler, servePlugin } from "@family-agenda/plugin-kit/server";
import { contractProblems, pluginClient } from "@family-agenda/plugin-kit/testing";
import { describePluginContract } from "@family-agenda/plugin-kit/vitest";
import { demoAttributes } from "../src";
import { demoPlugin, withDelay } from "../src/plugin";

const config = { plain: {}, secrets: {} };
const now = new Date("2026-09-14T07:00:00Z");
const egressProxy = "http://ticket:t@plugin-demo-egress:3128";

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
    const answer = await pluginClient(url)("poll", { config, syncCursor: null, now: now.toISOString(), timeZone: "Europe/Berlin", egressProxy });

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ attributes: { declared: [...demoAttributes] }, syncCursor: null });
    expect((answer.body as { sourceRecords: unknown[] }).sourceRecords.length).toBeGreaterThan(0);
  });
});

describe("the demo Source with a delay", () => {
  it("answers poll only after the delay, with the same answer", async () => {
    vi.useFakeTimers();
    try {
      const request = { config, syncCursor: null, now: now.toISOString(), timeZone: "Europe/Berlin", egressProxy };
      let settled = false;
      const answer = Promise.resolve(withDelay(demoPlugin, 2000).poll?.(request)).then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await answer).toEqual(await demoPlugin.poll?.(request));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the description as it is", () => {
    expect(withDelay(demoPlugin, 2000).description).toBe(demoPlugin.description);
  });
});

describe("the demo Source's endpoints that load after a page", () => {
  const context = { config, syncCursor: null, now: now.toISOString(), timeZone: "Europe/Berlin", egressProxy };

  it("adds a Source without setting any field itself", async () => {
    expect(await demoPlugin.sourceAdded?.({ config, now: context.now, timeZone: context.timeZone, egressProxy })).toEqual({ plain: {}, secrets: {} });
  });

  it("names its Source Attributes without a run", async () => {
    expect(await demoPlugin.sourceAttributes?.(context)).toEqual({ declared: [...demoAttributes], archived: [] });
  });

  it("offers made-up calendars for its choice field", async () => {
    expect(await demoPlugin.fieldChoices?.({ field: "calendars", context })).toEqual({
      choices: [
        { value: "family", label: "Family" },
        { value: "school", label: "School" },
        { value: "sports club", label: "Sports club" },
      ],
    });
  });
});
