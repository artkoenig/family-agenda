import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtractionRequest } from "@family-agenda/application";
import type { LocalDate, LocalTime } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenAiCompatibleExtractor } from "../src";

type Received = { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };

/** A stand-in for an OpenAI-compatible server that answers with what a test sets. */
async function startServer(): Promise<{
  baseUrl: string;
  received: Received[];
  answer(status: number, body: unknown): void;
  close(): Promise<void>;
}> {
  const received: Received[] = [];
  let next = { status: 200, body: {} as unknown };
  const server: Server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString()));
    request.on("end", () => {
      received.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(text) as Record<string, unknown> });
      response.writeHead(next.status, { "content-type": "application/json" });
      response.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    received,
    answer: (status, body) => {
      next = { status, body };
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

const completion = (content: string, finishReason = "stop") => ({
  choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
});

const event = {
  title: "Elternabend",
  date: { day: 17, month: 9, year: null, weekday: "thursday", daysAfter: null, weeksAfter: null },
  startTime: "19:30",
  endTime: null,
  place: "Raum 104",
  evidence: "Elternabend am Donnerstag, 17.09., um 19:30 Uhr",
};

const task = {
  title: "Sachen für den Ausflug",
  deadline: { day: 18, month: 9, year: null, weekday: "friday", daysAfter: null, weeksAfter: null },
  bring: ["Regenjacke", "Brotdose"],
  evidence: "für den Ausflug am Freitag, 18.09., bitte mitgeben: Regenjacke und Brotdose",
};

describe("the OpenAI-compatible Extractor", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(async () => {
    await server.close();
  });

  const request = (apiKey: string | null = "sk-test"): ExtractionRequest => ({
    endpoint: { baseUrl: server.baseUrl, model: "qwen3.5:9b", apiKey },
    message: {
      text: "Der Elternabend am Donnerstag, 17.09., um 19:30 Uhr findet in Raum 104 statt.",
      sent: { date: "2026-09-14" as LocalDate, time: "08:12" as LocalTime, weekday: "monday" },
    },
  });

  it("asks for JSON-schema output and reads the Events and Tasks from the answer", async () => {
    server.answer(200, completion(JSON.stringify({ events: [event], tasks: [task] })));

    const result = await new OpenAiCompatibleExtractor().extract(request());

    expect(result).toEqual({ ok: true, events: [event], tasks: [task] });
    const [sent] = server.received;
    expect(sent?.path).toBe("/v1/chat/completions");
    expect(sent?.headers.authorization).toBe("Bearer sk-test");
    expect(sent?.body).toMatchObject({
      model: "qwen3.5:9b",
      reasoning_effort: "low",
      response_format: { type: "json_schema", json_schema: { name: "items", strict: true } },
    });
    const prompt = JSON.stringify(sent?.body.messages);
    expect(prompt).toContain("sent on monday, 2026-09-14 at 08:12");
    expect(prompt).not.toContain("Known");
    expect(prompt).toContain("findet in Raum 104 statt.");
  });

  it("sends no API key to an endpoint without one", async () => {
    server.answer(200, completion(JSON.stringify({ events: [], tasks: [] })));

    expect(await new OpenAiCompatibleExtractor().extract(request(null))).toEqual({ ok: true, events: [], tasks: [] });
    expect(server.received[0]?.headers.authorization).toBeUndefined();
  });

  it("tells a refused key from an endpoint that cannot be reached", async () => {
    server.answer(401, { error: { message: "invalid api key" } });
    expect(await new OpenAiCompatibleExtractor().extract(request())).toMatchObject({ ok: false, problem: "unauthorized" });

    server.answer(503, { error: { message: "loading model" } });
    expect(await new OpenAiCompatibleExtractor().extract(request())).toMatchObject({ ok: false, problem: "unreachable" });

    await server.close();
    expect(await new OpenAiCompatibleExtractor().extract(request())).toMatchObject({ ok: false, problem: "unreachable" });
    server = await startServer();
  });

  it("refuses an answer that does not fit the schema, or was cut off", async () => {
    const extractor = new OpenAiCompatibleExtractor();
    for (const content of [
      "Sure! Here are the events:",
      JSON.stringify({ events: [{ ...event, evidence: undefined }], tasks: [] }),
      JSON.stringify({ events: [{ ...event, date: { ...event.date, weekday: "donnerstag" } }], tasks: [] }),
      JSON.stringify({ events: [{ ...event, date: { ...event.date, day: "17" } }], tasks: [] }),
      JSON.stringify({ events: [event] }),
      JSON.stringify({ events: [], tasks: [{ ...task, bring: "Regenjacke" }] }),
      JSON.stringify({ events: [], tasks: [{ ...task, bring: [1] }] }),
      JSON.stringify({ events: [], tasks: [{ ...task, deadline: null }] }),
    ]) {
      server.answer(200, completion(content));
      expect(await extractor.extract(request()), content).toMatchObject({ ok: false, problem: "invalid-output" });
    }

    server.answer(200, completion(JSON.stringify({ events: [event], tasks: [] }).slice(0, 40), "length"));
    expect(await extractor.extract(request())).toMatchObject({ ok: false, problem: "invalid-output" });
  });
});

describe("the OpenAI-compatible Extractor's connection check", () => {
  let server: Server;
  let baseUrl: string;
  let received: { path: string; headers: IncomingMessage["headers"] }[];
  let nextStatus: number;
  let nextBody: unknown;

  async function start(): Promise<void> {
    received = [];
    nextStatus = 200;
    nextBody = { data: [] };
    server = createServer((request, response) => {
      received.push({ path: request.url ?? "", headers: request.headers });
      response.writeHead(nextStatus, { "content-type": "application/json" });
      response.end(JSON.stringify(nextBody));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  }

  async function stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }

  beforeEach(async () => {
    await start();
  });
  afterEach(async () => {
    await stop();
  });

  const endpoint = (apiKey: string | null = "sk-test") => ({
    baseUrl,
    model: "qwen3.5:9b",
    apiKey,
  });

  const check = (key: string | null = "sk-test") => new OpenAiCompatibleExtractor().check(endpoint(key));

  it("lists the sorted, distinct ids of the models the endpoint offers", async () => {
    nextBody = { data: [{ id: "qwen3.5:9b" }, { id: "gemma3" }, { id: "qwen3.5:9b" }, { id: "" }, { name: "no id" }] };

    expect(await check()).toEqual({ ok: true, models: ["gemma3", "qwen3.5:9b"] });
    expect(received[0]?.path).toBe("/v1/models");
  });

  it("lists no models when the answer does not look like a model list", async () => {
    nextBody = { models: ["gemma3"] };
    expect(await check()).toEqual({ ok: true, models: [] });
  });

  it("reports a refused key when the endpoint answers 401", async () => {
    nextStatus = 401;
    expect(await check()).toEqual({ ok: false, message: "The LLM endpoint refused the API key (HTTP 401)." });
  });

  it("reports a refused key when the endpoint answers 403", async () => {
    nextStatus = 403;
    expect(await check()).toEqual({ ok: false, message: "The LLM endpoint refused the API key (HTTP 403)." });
  });

  it("reports an error status for other non-ok answers", async () => {
    nextStatus = 500;
    expect(await check()).toEqual({ ok: false, message: "The LLM endpoint answered with HTTP 500." });
  });

  it("reports unreachable when the endpoint cannot be reached", async () => {
    await stop();
    baseUrl = "http://127.0.0.1:1/v1";
    const answer = await check(null);
    expect(answer).toMatchObject({ ok: false });
    expect(JSON.stringify(answer)).toContain("could not be reached");
  });

  it("sends the API key in the Authorization header", async () => {
    await check("sk-secret");
    expect(received[0]?.headers.authorization).toBe("Bearer sk-secret");
  });

  it("sends no Authorization header when there is no API key", async () => {
    await check(null);
    expect(received[0]?.headers.authorization).toBeUndefined();
  });
});
