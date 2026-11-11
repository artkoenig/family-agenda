import type { Origin } from "../support/test-source-plugin";
import { openAgendaAccess, type Showing } from "@family-agenda/application";
import type { AgendaId, FamilyMemberId, SourceId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls } from "../support/test-source-plugin";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

/** The mail of the school's mailing list, as each mailbox on the list receives it. */
const mail = (folder = "INBOX"): Origin => ({
  externalId: "<wandertag@schule.example.org>",
  occurredAt: new Date("2026-09-14T06:12:00Z"),
  sender: "Frau Berger",
  attributes: [folder],
  content: { kind: "raw-message", text: "Am Freitag, 18.09., ist der Wandertag der 5b.", attachments: [] },
});

describe("A message that several Sources of one Source Type deliver", () => {
  let instance: TestInstance;
  let extractor: ScriptedExtractor;
  let agenda: AgendaId;
  let miasMailbox: SourceId;
  let leosMailbox: SourceId;
  let mia: FamilyMemberId;
  let leo: FamilyMemberId;
  const mias = "mia.mail.example.org";
  const leos = "leo.mail.example.org";
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    extractor = new ScriptedExtractor();
    extractor.script("Wandertag", [
      extracted({ title: "Wandertag 5b", date: { day: 18, month: 9, weekday: "friday" }, evidence: "Freitag, 18.09., ist der Wandertag" }),
    ]);
    instance = await bootForTest({ extractor, blobStore: new InMemoryBlobStore() });
    await instance.installPlugin({ sourceTypeId: "mail", needsLlm: true });
    await instance.installPlugin({ sourceTypeId: "chat", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mail");
    await instance.app.sourceTypes.enable("chat");
    miasMailbox = await source("mail", mias);
    leosMailbox = await source("mail", leos);
    mia = await member("Mia");
    leo = await member("Leo");
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const created = await instance.app.agendas.create({ memberIds: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    agenda = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  const source = async (sourceTypeId: string, url: string): Promise<SourceId> => {
    const added = await instance.app.sources.add({ sourceTypeId, plain: { url }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    return added.id;
  };

  const member = async (name: string): Promise<FamilyMemberId> => {
    const result = await instance.app.familyMembers.add({ name });
    if (!result.ok) throw new Error(`adding failed: ${result.problem}`);
    return result.id;
  };

  /** Assigns a folder of a mailbox, its inbox unless another is named, to the Family Members. */
  const assignInbox = async (source: SourceId, members: FamilyMemberId[], folder = "INBOX") => {
    const listed = (await instance.app.sources.list()).find((candidate) => candidate.id === source);
    const inbox = listed?.attributes.find((attribute) => attribute.name === folder);
    if (!inbox) throw new Error(`the mailbox has no ${folder} yet`);
    const result = await instance.app.sources.assignAttribute(inbox.id, members);
    if (!result.ok) throw new Error(`assigning failed: ${result.problem}`);
  };

  /** The rows of the timeline as title and whom they concern, by name. */
  const concerning = async (show: Showing = "all") => {
    const { members, items } = await rows(show);
    const names = new Map(members.map((candidate) => [candidate.id, candidate.name]));
    return items.map((row) => `${row.title}: ${row.concerns === "whole-family" ? "Family" : row.concerns.map((id) => names.get(id)).join(", ")}`);
  };

  /** The Sources run, and the worker reads what waits. */
  const run = async () => {
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
  };

  const rows = async (show: Showing = "all") => {
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess, show });
    return { members: page?.members ?? [], items: (page?.days ?? []).flatMap((day) => day.items) };
  };
  const titles = async (show: Showing = "all") => (await rows(show)).items.map((item) => item.title);

  it("writes its Items once when the Copies arrive together", async () => {
    testPluginControls.emitFor("mail", mias, [mail()]);
    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();

    expect(await titles()).toEqual(["Wandertag 5b"]);
    expect(extractor.requests, "the message is read by the LLM once").toHaveLength(1);
    expect(await instance.app.extraction.waiting(), "no Copy waits to be read").toBe(0);
    expect(await instance.query("SELECT count(*)::int AS n FROM source_record"), "each mailbox keeps its Source Record").toEqual([{ n: 2 }]);
  });

  it("writes its Items once when three Sources deliver it", async () => {
    const omas = "oma.mail.example.org";
    await source("mail", omas);
    for (const url of [mias, leos, omas]) testPluginControls.emitFor("mail", url, [mail()]);
    await run();

    expect(await titles()).toEqual(["Wandertag 5b"]);
    expect(extractor.requests).toHaveLength(1);
  });

  it("does not read a Copy that arrives after its Items were written", async () => {
    testPluginControls.emitFor("mail", mias, [mail()]);
    await run();
    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();

    expect(await titles()).toEqual(["Wandertag 5b"]);
    expect(extractor.requests).toHaveLength(1);
    expect(await instance.app.extraction.waiting()).toBe(0);
  });

  it("does not bring back an Item an Admin deleted when a Copy arrives later", async () => {
    testPluginControls.emitFor("mail", mias, [mail()]);
    await run();
    const [item] = (await rows()).items;
    await instance.app.messages.deleteItem(item!.itemId);

    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();

    expect(await titles()).toEqual([]);
    expect(extractor.requests).toHaveLength(1);
  });

  it("reads a message with the same external id in a Source of another Source Type on its own", async () => {
    await source("chat", "chat.example.org");
    testPluginControls.emitFor("mail", mias, [mail()]);
    testPluginControls.emit("chat", [mail()]);
    await run();

    expect(await titles()).toEqual(["Wandertag 5b", "Wandertag 5b"]);
    expect(extractor.requests).toHaveLength(2);
  });

  it("leaves calendar entries with the same external id in two Sources their own Items", async () => {
    const entry: Origin = {
      externalId: "piano",
      attributes: ["INBOX"],
      content: { kind: "stated", stated: { kind: "event", title: "Piano", span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" }, place: null, cancelled: false } },
    };
    testPluginControls.emitFor("mail", mias, [entry]);
    testPluginControls.emitFor("mail", leos, [entry]);
    await run();

    expect(await titles()).toEqual(["Piano", "Piano"]);
  });

  it("lets its Items concern everyone any Copy concerns", async () => {
    testPluginControls.emitFor("mail", mias, [mail()]);
    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();
    await assignInbox(miasMailbox, [mia]);
    await assignInbox(leosMailbox, [leo]);

    expect(await concerning()).toEqual(["Wandertag 5b: Mia, Leo"]);
    expect(await titles([mia])).toEqual(["Wandertag 5b"]);
    expect(await titles([leo])).toEqual(["Wandertag 5b"]);
  });

  it("lets its Items concern the whole Family when the inbox of one Copy is assigned to no one", async () => {
    testPluginControls.emitFor("mail", mias, [mail()]);
    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();
    await assignInbox(miasMailbox, [mia]);

    expect(await concerning()).toEqual(["Wandertag 5b: Family"]);
  });

  describe("when Mia's mailbox delivered it first and Leo's later", () => {
    const withdrawn = [mail().externalId];
    beforeEach(async () => {
      testPluginControls.emitFor("mail", mias, [mail()]);
      await run();
      testPluginControls.emitFor("mail", leos, [mail()]);
      await run();
      await assignInbox(miasMailbox, [mia]);
      await assignInbox(leosMailbox, [leo]);
    });

    it("no longer concerns those of a Copy that is withdrawn", async () => {
      testPluginControls.emitFor("mail", leos, [], withdrawn);
      await run();

      expect(await concerning()).toEqual(["Wandertag 5b: Mia"]);
    });

    it("no longer concerns those of a Copy that names no Source Attribute any more", async () => {
      testPluginControls.emitFor("mail", leos, [{ ...mail(), attributes: [] }]);
      await run();

      expect(await concerning()).toEqual(["Wandertag 5b: Mia"]);
    });

    it("shows each Copy with the Source Attributes of its own Source", async () => {
      const [item] = (await rows()).items;
      const opened = await instance.app.messages.open(item!.messages[0]!.id);

      expect(opened?.attributes).toEqual(["INBOX"]);
    });

    it("loses its Items with the Copy that was read, though another remains", async () => {
      testPluginControls.emitFor("mail", mias, [], withdrawn);
      await run();

      expect(await concerning()).toEqual([]);
      expect(extractor.requests, "the Copy that remains is not read in its place").toHaveLength(1);
    });

    it("follows a Copy that was not read to another folder", async () => {
      testPluginControls.emitFor("mail", leos, [mail("Schule")]);
      await run();
      expect(await concerning(), "the new folder is assigned to no one").toEqual(["Wandertag 5b: Family"]);

      await assignInbox(leosMailbox, [leo], "Schule");
      expect(await concerning()).toEqual(["Wandertag 5b: Mia, Leo"]);
    });

    it("keeps concerning those of the other Copy when the one that was read moves to another folder", async () => {
      testPluginControls.emitFor("mail", mias, [mail("Schule")]);
      await run();
      await assignInbox(miasMailbox, [mia], "Schule");

      expect(await concerning()).toEqual(["Wandertag 5b: Mia, Leo"]);
    });

    it("no longer concerns those of a Copy whose Source is removed", async () => {
      await instance.app.sources.remove(leosMailbox);

      expect(await concerning()).toEqual(["Wandertag 5b: Mia"]);
    });
  });

  it("reads a Copy that arrives when every earlier Copy is withdrawn", async () => {
    testPluginControls.emitFor("mail", mias, [mail()]);
    await run();
    testPluginControls.emitFor("mail", mias, [], [mail().externalId]);
    await run();
    expect(await titles()).toEqual([]);

    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();

    expect(await titles()).toEqual(["Wandertag 5b"]);
    expect(extractor.requests).toHaveLength(2);
  });

  it("reads a Copy that arrives after the one that was read was withdrawn and came back without its content", async () => {
    testPluginControls.emitFor("mail", mias, [mail()]);
    await run();
    testPluginControls.emitFor("mail", mias, [], [mail().externalId]);
    await run();
    testPluginControls.emitFor("mail", mias, [mail()]);
    await run();
    expect(await titles(), "a message is not read again in its Source").toEqual([]);

    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();

    expect(await titles()).toEqual(["Wandertag 5b"]);
  });

  it("reads the message once when its extraction failed before", async () => {
    extractor.fail("unreachable");
    testPluginControls.emitFor("mail", mias, [mail()]);
    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();
    expect(await titles()).toEqual([]);
    expect(extractor.requests, "only one Copy was tried").toHaveLength(1);

    extractor.recover();
    await run();

    expect(await titles()).toEqual(["Wandertag 5b"]);
    expect(extractor.requests).toHaveLength(2);
    expect(await instance.app.extraction.waiting()).toBe(0);
  });

  describe("when the first Copy still waits to be read", () => {
    const omas = "oma.mail.example.org";
    let extractorRequestsBefore: number;
    beforeEach(async () => {
      await source("mail", omas);
      extractor.fail("unreachable");
      testPluginControls.emitFor("mail", mias, [mail()]);
      await run();
      testPluginControls.emitFor("mail", leos, [mail()]);
      testPluginControls.emitFor("mail", omas, [mail()]);
      await run();
      await assignInbox(miasMailbox, [mia]);
      await assignInbox(leosMailbox, [leo]);
      extractor.recover();
      extractorRequestsBefore = extractor.requests.length;
    });

    it("follows a later Copy to another folder", async () => {
      testPluginControls.emitFor("mail", leos, [mail("Schule")]);
      await run();

      expect(await concerning(), "Oma's inbox and Leo's new folder are assigned to no one").toEqual(["Wandertag 5b: Family"]);
      await assignInbox(leosMailbox, [mia], "Schule");
      const [oma] = (await instance.app.sources.list()).filter((listed) => ![miasMailbox, leosMailbox].includes(listed.id));
      await assignInbox(oma!.id, [mia]);
      expect(await concerning(), "Leo's inbox no longer counts").toEqual(["Wandertag 5b: Mia"]);
    });

    it("reads one of the later Copies in its place when it is withdrawn", async () => {
      testPluginControls.emitFor("mail", mias, [], [mail().externalId]);
      await run();

      expect(await titles()).toEqual(["Wandertag 5b"]);
      expect(extractor.requests.length, "the two later Copies are read once between them").toBe(extractorRequestsBefore + 1);
      expect(await concerning(), "Oma's inbox is assigned to no one").toEqual(["Wandertag 5b: Family"]);
      const [oma] = (await instance.app.sources.list()).filter((listed) => ![miasMailbox, leosMailbox].includes(listed.id));
      await assignInbox(oma!.id, [leo]);
      expect(await concerning(), "Mia's Copy is gone").toEqual(["Wandertag 5b: Leo"]);
    });
  });
});
