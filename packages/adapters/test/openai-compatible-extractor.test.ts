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
  updates: null,
  cancelled: false,
  title: "Elternabend",
  date: { day: 17, month: 9, year: null, weekday: "thursday", daysAfter: null, weeksAfter: null },
  startTime: "19:30",
  endTime: null,
  place: "Raum 104",
  evidence: "Elternabend am Donnerstag, 17.09., um 19:30 Uhr",
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
    endpoint: { baseUrl: server.baseUrl, model: "qwen3.5:9b", apiKey, vision: false },
    message: {
      text: "Der Elternabend am Donnerstag, 17.09., um 19:30 Uhr findet in Raum 104 statt.",
      sent: { date: "2026-09-14" as LocalDate, time: "08:12" as LocalTime, weekday: "monday" },
    },
    knownEvents: [{ ref: "E1", title: "Sportfest", when: "2026-09-20, all day", place: null }],
  });

  it("asks for JSON-schema output and reads the Events from the answer", async () => {
    server.answer(200, completion(JSON.stringify({ events: [event] })));

    const result = await new OpenAiCompatibleExtractor().extract(request());

    expect(result).toEqual({ ok: true, events: [event] });
    const [sent] = server.received;
    expect(sent?.path).toBe("/v1/chat/completions");
    expect(sent?.headers.authorization).toBe("Bearer sk-test");
    expect(sent?.body).toMatchObject({
      model: "qwen3.5:9b",
      reasoning_effort: "low",
      response_format: { type: "json_schema", json_schema: { name: "events", strict: true } },
    });
    const prompt = JSON.stringify(sent?.body.messages);
    expect(prompt).toContain("sent on monday, 2026-09-14 at 08:12");
    expect(prompt).toContain("E1: Sportfest, 2026-09-20, all day");
    expect(prompt).toContain("findet in Raum 104 statt.");
  });

  it("sends no API key to an endpoint without one", async () => {
    server.answer(200, completion(JSON.stringify({ events: [] })));

    expect(await new OpenAiCompatibleExtractor().extract(request(null))).toEqual({ ok: true, events: [] });
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
      JSON.stringify({ events: [{ ...event, evidence: undefined }] }),
      JSON.stringify({ events: [{ ...event, date: { ...event.date, weekday: "donnerstag" } }] }),
      JSON.stringify({ events: [{ ...event, date: { ...event.date, day: "17" } }] }),
    ]) {
      server.answer(200, completion(content));
      expect(await extractor.extract(request()), content).toMatchObject({ ok: false, problem: "invalid-output" });
    }

    server.answer(200, completion(JSON.stringify({ events: [event] }).slice(0, 40), "length"));
    expect(await extractor.extract(request())).toMatchObject({ ok: false, problem: "invalid-output" });
  });

  describe("reading scanned pages", () => {
    const page = (marker: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, marker]);
    const transcription = (images: Uint8Array[]) => ({
      endpoint: { baseUrl: server.baseUrl, model: "qwen3.5-vl", apiKey: "sk-test", vision: true },
      images,
    });

    it("sends each page as an image and reads its text word for word", async () => {
      const extractor = new OpenAiCompatibleExtractor();
      server.answer(200, completion("Der Wandertag findet am Freitag, 25.09., statt."));

      const result = await extractor.transcribe(transcription([page(1), page(2)]));

      expect(result).toEqual({
        ok: true,
        pages: ["Der Wandertag findet am Freitag, 25.09., statt.", "Der Wandertag findet am Freitag, 25.09., statt."],
      });
      expect(server.received).toHaveLength(2);
      const [first] = server.received;
      expect(first?.path).toBe("/v1/chat/completions");
      expect(first?.headers.authorization).toBe("Bearer sk-test");
      expect(first?.body).toMatchObject({ model: "qwen3.5-vl" });
      expect(first?.body.response_format).toBeUndefined();
      expect(JSON.stringify(first?.body.messages)).toContain(
        `"image_url":{"url":"data:image/png;base64,${Buffer.from(page(1)).toString("base64")}"}`,
      );
    });

    it("tells a refused key and an endpoint that cannot be reached from an answer without text", async () => {
      const extractor = new OpenAiCompatibleExtractor();
      server.answer(401, { error: { message: "invalid api key" } });
      expect(await extractor.transcribe(transcription([page(1)]))).toMatchObject({ ok: false, problem: "unauthorized" });

      server.answer(503, { error: { message: "loading model" } });
      expect(await extractor.transcribe(transcription([page(1)]))).toMatchObject({ ok: false, problem: "unreachable" });

      server.answer(200, { choices: [] });
      expect(await extractor.transcribe(transcription([page(1)]))).toMatchObject({ ok: false, problem: "invalid-output" });
    });

    it("takes a refused image for a problem with the page, so that a model without vision holds up no other mail", async () => {
      server.answer(400, { error: { message: "model does not support images" } });

      expect(await new OpenAiCompatibleExtractor().transcribe(transcription([page(1)]))).toEqual({
        ok: false,
        problem: "invalid-output",
        message: "The LLM endpoint refused the page images (HTTP 400); its model may not read images.",
      });
    });
  });
});
