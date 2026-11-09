import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { contractVersion, limits } from "@family-agenda/plugin-contract";
import { PluginError, type PluginImplementation } from "../src";
import type { ServerResponse } from "node:http";
import { answerUnexpectedFailure, createPluginHandler, describePlugin, servePlugin } from "../src/server";
import { answerProblems, contractProblems, pluginClient } from "../src/testing";

const context = { config: { plain: {}, secrets: {} }, syncCursor: null, now: "2026-11-09T10:00:00.000Z", timeZone: "Europe/Berlin" };
const config = context.config;

const record = (externalId: string, attributes: string[], kind: "stated" | "raw-message" = "stated") => ({
  externalId,
  attributes,
  content:
    kind === "stated"
      ? { kind, stated: { kind: "task" as const, title: "Pack", deadline: null, bring: [] } }
      : { kind, text: "Hello", attachments: [] },
});

function plugin(overrides: Partial<PluginImplementation> = {}, description: Partial<PluginImplementation["description"]> = {}): PluginImplementation {
  return {
    description: {
      sourceTypeId: "fake",
      kind: "stateless",
      displayName: { en: "Fake", de: "Attrappe" },
      version: "1.0.0",
      description: { en: "A fake", de: "Eine Attrappe" },
      needsLlm: false,
      configuration: { version: 1, fields: [] },
      setupSteps: [],
      ingestion: { mode: "polling", suggestedIntervalSeconds: 60 },
      silentApplies: false,
      ...description,
    },
    poll: () => ({ sourceRecords: [record("a", ["x"])], syncCursor: "1", attributes: { declared: [{ externalId: "x", name: "X" }], archived: [] } }),
    ...overrides,
  };
}

const call = (implementation: PluginImplementation) => pluginClient(createPluginHandler(implementation));

describe("the server helper", () => {
  it("describes the plugin with the contract version and the optional endpoints it implements", () => {
    expect(describePlugin(plugin({ sourceRemoved: () => undefined }))).toMatchObject({ contractVersion, endpoints: { sourceAdded: false, sourceRemoved: true } });
  });

  it("passes a validated request to the endpoint and answers with its response", async () => {
    const answer = await call(plugin())("poll", context);
    expect(answer).toMatchObject({ status: 200, body: { syncCursor: "1" } });
  });

  it("answers 204 for an endpoint without a response", async () => {
    expect(await call(plugin({ sourceRemoved: () => undefined }))("sourceRemoved", context)).toEqual({ status: 204, body: undefined });
  });

  it("refuses an unknown or unimplemented endpoint, an invalid or a too large request with a definite error", async () => {
    const handle = createPluginHandler(plugin());
    const post = (path: string, body: string) => handle(new Request(`http://plugin${path}`, { method: "POST", body }));

    expect((await handle(new Request("http://plugin/nowhere"))).status).toBe(404);
    expect((await call(plugin())("fieldChoices", { field: "x", context })).status).toBe(404);
    expect((await post("/poll", "{")).status).toBe(400);
    expect(await (await post("/poll", "{}")).json()).toMatchObject({ kind: "definite" });
    expect((await post("/poll", "x".repeat(limits.maxPayloadBytes + 1))).status).toBe(413);
  });

  it("answers what a handler throws as a definite, temporary or unexpected error", async () => {
    const throwing = (thrown: unknown) =>
      call(
        plugin({
          poll: () => {
            throw thrown;
          },
        }),
      )("poll", context);

    expect(await throwing(new PluginError("definite", "wrong password"))).toEqual({ status: 422, body: { kind: "definite", message: "wrong password" } });
    expect(await throwing(new PluginError("temporary", "busy"))).toEqual({ status: 503, body: { kind: "temporary", message: "busy" } });
    expect(await throwing(new Error("bug"))).toEqual({ status: 500, body: { kind: "temporary", message: "bug" } });
    expect(await throwing("odd")).toEqual({ status: 500, body: { kind: "temporary", message: "odd" } });
  });

  it("never answers with a response the contract does not allow", async () => {
    const answer = await call(plugin({ poll: () => ({ sourceRecords: "none" }) as never }))("poll", context);
    expect(answer).toMatchObject({ status: 500, body: { kind: "temporary" } });
  });

  it("answers a failure outside the handler with a temporary error, or drops a half-sent answer", () => {
    const sent: unknown[] = [];
    const outgoing = (headersSent: boolean) =>
      ({
        headersSent,
        writeHead: (status: number) => sent.push(status),
        end: (body: string) => sent.push(JSON.parse(body)),
        destroy: () => sent.push("destroyed"),
      }) as unknown as ServerResponse;

    answerUnexpectedFailure(outgoing(false), new Error("aborted"));
    answerUnexpectedFailure(outgoing(false), "odd");
    answerUnexpectedFailure(outgoing(true), new Error("late"));

    expect(sent).toEqual([500, { kind: "temporary", message: "aborted" }, 500, { kind: "temporary", message: "odd" }, "destroyed"]);
  });

  it("serves a plugin over HTTP", async () => {
    const server = await servePlugin(plugin(), { host: "127.0.0.1" });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      expect((await pluginClient(url)("description")).body).toMatchObject({ sourceTypeId: "fake" });
      expect((await pluginClient(url)("poll", context)).status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe("the contract harness", () => {
  it("finds nothing wrong with a plugin that keeps the contract", async () => {
    expect(await contractProblems(createPluginHandler(plugin()), { config, languages: ["de"] })).toEqual([]);
  });

  it("finds a wrong status or an invalid answer", () => {
    expect(answerProblems("description", { status: 500, body: {} })).toHaveLength(1);
    expect(answerProblems("sourceRemoved", { status: 200, body: {} })).toEqual(["sourceRemoved answered 200, not 204"]);
    expect(answerProblems("description", { status: 200, body: {} })[0]).toMatch(/invalidly/);
  });

  it("finds a plugin that cannot describe itself or is built for another contract version", async () => {
    const broken = () => Promise.resolve(Response.json({}, { status: 500 }));
    await expect(contractProblems(broken)).rejects.toThrow(/description answered 500/);

    const old = (request: Request) =>
      createPluginHandler(plugin())(request).then(async (response) =>
        new URL(request.url).pathname === "/description" ? Response.json({ ...((await response.json()) as object), contractVersion: "0.9" }) : response,
      );
    expect((await contractProblems(old))[0]).toMatch(/built for plugin contract 0.9/);
  });

  it("finds a plugin that accepts an invalid request", async () => {
    const lenient = (request: Request) => (new URL(request.url).pathname === "/poll" ? Promise.resolve(Response.json({ sourceRecords: [], syncCursor: null })) : createPluginHandler(plugin())(request));
    expect(await contractProblems(lenient)).toContainEqual(expect.stringMatching(/invalid poll request was answered 200/));
  });

  it("finds duplicates, texts not given in a language, and a missing migration", async () => {
    const field = { key: "url", label: "URL", secret: false, required: true, hasChoices: false };
    const step = { id: "s", title: "T", description: "D", live: false };
    const duplicated = plugin(
      { catalogueEntries: () => ({ entries: [1, 2].map(() => ({ id: "e", displayName: "E", description: "D", installed: false })) }) },
      { configuration: { version: 2, fields: [field, field] }, setupSteps: [step, step], catalogue: { title: "C", configKey: "installed" } },
    );

    const problems = await contractProblems(createPluginHandler(duplicated), { languages: ["de"] });

    expect(problems).toEqual(
      expect.arrayContaining([
        "setup step s is listed more than once",
        "configuration field url is listed more than once",
        "catalogue entry e is listed more than once",
        expect.stringMatching(/configMigration answered 404/),
        "configuration field url's label is not given in de",
        "the catalogue's title is not given in de",
        "catalogue entry e is not given in de",
      ]),
    );
  });

  it("finds a plugin that names Source Attributes it never declared, or emits a message again", async () => {
    const careless = plugin({ poll: () => ({ sourceRecords: [record("a", ["x"]), record("m", [], "raw-message")], syncCursor: null }) });

    expect(await contractProblems(createPluginHandler(careless), { config, now: new Date() })).toEqual([
      "Source Record a names undeclared Source Attribute x",
      "Source Record a names undeclared Source Attribute x",
      "message m came again with the sync cursor of the first run",
    ]);
  });

  it("polls in the time zone it is given", async () => {
    const zones: string[] = [];
    const recording = plugin({
      poll: (request) => {
        zones.push(request.timeZone);
        return { sourceRecords: [], syncCursor: null };
      },
    });
    await contractProblems(createPluginHandler(recording), { config, timeZone: "America/New_York" });
    expect(zones).toEqual(["America/New_York", "America/New_York"]);
  });

  it("finds a poll that fails, and does not poll a push plugin or one without a configuration", async () => {
    const failing = plugin({ poll: () => Promise.reject(new PluginError("definite", "no")) });
    expect(await contractProblems(createPluginHandler(failing), { config })).toContainEqual(expect.stringMatching(/poll answered 422/));
    expect(await contractProblems(createPluginHandler(failing))).toEqual([]);
    const push = plugin({ receive: () => ({ sourceRecords: [], syncCursor: null }) }, { ingestion: { mode: "push" } });
    delete push.poll;
    expect(await contractProblems(createPluginHandler(push), { config })).toEqual([]);
  });
});
