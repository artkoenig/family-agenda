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
  description: "- Regenjacke\n- Brotdose",
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
      own: false,
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

  it("tells the model to list nothing from the quoted text of a reply, but to read a forward", async () => {
    server.answer(200, completion(JSON.stringify({ events: [], tasks: [] })));

    await new OpenAiCompatibleExtractor().extract(request());

    const system = JSON.stringify(server.received[0]?.body.messages);
    expect(system).toContain("quotes the message it answers");
    expect(system).toContain("Am 3. November 2026 um 08:12 schrieb");
    expect(system).toContain("A forwarded message");
  });

  it("tells the model of every message whether the family or someone else wrote it, which decides on offers", async () => {
    server.answer(200, completion(JSON.stringify({ events: [], tasks: [] })));
    const { endpoint, message } = request();

    await new OpenAiCompatibleExtractor().extract({ endpoint, message: { ...message, own: true } });
    await new OpenAiCompatibleExtractor().extract({ endpoint, message: { ...message, own: false } });

    const contents = (role: string) =>
      server.received.map((received) => (received.body.messages as { role: string; content: string }[]).find((sent) => sent.role === role)?.content);
    expect(contents("user")[0]).toContain("It was written by: the family.");
    expect(contents("user")[1]).toContain("It was written by: someone else.");
    expect(contents("system")[0]).toContain("Written by someone else: what the writer offers or promises to do or bring is not a task");
    expect(contents("system")[0]).toContain("Written by the family: what the writer offers or promises to do or bring is a task of the family");
    expect(contents("system")[0]).toContain("What the writer asks of others is a task only if the message says by or on which day it is to be done");
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

  it("tells an endpoint that does not answer in time, which counts against the message", async () => {
    const silent = createServer(() => {
      // Never answers.
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const extractor = new OpenAiCompatibleExtractor({ timeoutMs: 50 });
      const result = await extractor.extract({ ...request(), endpoint: { ...request().endpoint, baseUrl: `http://127.0.0.1:${port}/v1` } });
      expect(result).toEqual({ ok: false, problem: "timeout", message: "The LLM endpoint did not answer within 0.05 s." });
    } finally {
      silent.closeAllConnections();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it("refuses an answer that does not fit the schema, or was cut off", async () => {
    const extractor = new OpenAiCompatibleExtractor();
    for (const content of [
      "Sure! Here are the events:",
      JSON.stringify({ events: [{ ...event, evidence: undefined }], tasks: [] }),
      JSON.stringify({ events: [{ ...event, date: { ...event.date, weekday: "donnerstag" } }], tasks: [] }),
      JSON.stringify({ events: [{ ...event, date: { ...event.date, day: "17" } }], tasks: [] }),
      JSON.stringify({ events: [event] }),
      JSON.stringify({ events: [], tasks: [{ ...task, description: ["Regenjacke"] }] }),
      JSON.stringify({ events: [], tasks: [{ ...task, description: undefined }] }),
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
