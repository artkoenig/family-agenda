import type { Origin } from "../support/test-source-plugin";
import { TestClock } from "pg-boss";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls } from "../support/test-source-plugin";

const minutes = 60 * 1000;

const mail = (id: string, text: string): Origin => ({
  externalId: id,
  occurredAt: new Date("2026-09-14T06:00:00Z"),
  attributes: ["main"],
  content: { kind: "raw-message", text, attachments: [] },
});

describe("The worker's work from pg-boss schedules", () => {
  let instance: TestInstance;
  let schedules: TestClock;
  let logged: string[];
  beforeEach(async () => {
    const extractor = new ScriptedExtractor();
    extractor.script("Wandertag", [extracted({ title: "Wandertag", date: { day: 18, month: 9, weekday: "friday" }, evidence: "Freitag, 18.09., ist der Wandertag" })]);
    instance = await bootForTest({ extractor, blobStore: new InMemoryBlobStore() });
    await instance.installPlugin({ sourceTypeId: "mailbox", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    const added = await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "imap.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    schedules = new TestClock("2026-09-14T07:00:30Z");
    logged = [];
  });
  afterEach(async () => {
    await instance.close();
  });

  const log = { warn: (line: string) => logged.push(line), error: (line: string) => logged.push(line) };

  /** Moves the schedules' clock on by whole minutes, letting the work each one starts run on real time. */
  const scheduleMinutes = async (count: number) => {
    for (let i = 0; i < count * 12; i++) {
      await schedules.tick(5_000);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const items = () => instance.query("SELECT count(*)::int AS n FROM item");

  it("polls a due Source and extracts what it brought within about a minute", async () => {
    await instance.bootWorker(schedules, log);
    testPluginControls.emit("mailbox", [mail("m1", "Am Freitag, 18.09., ist der Wandertag.")]);
    instance.clock.advance(15 * minutes);

    await scheduleMinutes(1);

    expect(await items()).toEqual([{ n: 1 }]);
  });

  it("logs what a Source's records were refused for, as the worker always has", async () => {
    await instance.bootWorker(schedules, log);
    testPluginControls.emit("mailbox", [mail("m1", "Am Freitag, 18.09., ist der Wandertag.")], { declaring: false });
    instance.clock.advance(15 * minutes);

    await scheduleMinutes(1);

    expect(logged.some((line) => line.startsWith("Source ") && line.includes("never declared or had archived"))).toBe(true);
  });

  it("runs each occurrence once with two workers on one database", async () => {
    await instance.bootWorker(schedules, log);
    await instance.bootWorker(schedules, log);
    testPluginControls.emit("mailbox", [mail("m1", "Am Freitag, 18.09., ist der Wandertag.")]);
    instance.clock.advance(15 * minutes);

    await scheduleMinutes(2);

    expect(await instance.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'due-work'")).toEqual([{ n: 2 }]);
    expect(await items()).toEqual([{ n: 1 }]);
  });

  it("purges messages past their retention once an hour", { timeout: 60_000 }, async () => {
    await instance.bootWorker(schedules, log);

    // Most of the hour at once: the due work its minutes send runs on, and is not looked at here.
    await schedules.tick(58 * minutes);
    await scheduleMinutes(3);

    expect(await instance.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'purge'")).toEqual([{ n: 1 }]);
  });

  it("sweeps unreferenced secrets when it starts", async () => {
    await instance.bootWorker(schedules, log);

    await scheduleMinutes(1);

    expect(await instance.query("SELECT state FROM pgboss.job WHERE name = 'secret-sweep'")).toEqual([{ state: "completed" }]);
  });
});
