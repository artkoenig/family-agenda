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
const mail = (id = "<wandertag@schule.example.org>"): Origin => ({
  externalId: id,
  occurredAt: new Date("2026-09-14T06:12:00Z"),
  sender: "Frau Berger",
  attributes: ["INBOX"],
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
    miasMailbox = await mailbox("mail", mias);
    leosMailbox = await mailbox("mail", leos);
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

  const mailbox = async (sourceTypeId: string, url: string): Promise<SourceId> => {
    const added = await instance.app.sources.add({ sourceTypeId, plain: { url }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    return added.id;
  };

  const member = async (name: string): Promise<FamilyMemberId> => {
    const result = await instance.app.familyMembers.add({ name });
    if (!result.ok) throw new Error(`adding failed: ${result.problem}`);
    return result.id;
  };

  /** Assigns the inbox of a mailbox to the Family Members. */
  const assignInbox = async (source: SourceId, members: FamilyMemberId[]) => {
    const listed = (await instance.app.sources.list()).find((candidate) => candidate.id === source);
    const inbox = listed?.attributes.find((attribute) => attribute.name === "INBOX");
    if (!inbox) throw new Error("the mailbox has no inbox yet");
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

  it("writes its Items once when the copies arrive together", async () => {
    testPluginControls.emitFor("mail", mias, [mail()]);
    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();

    expect(await titles()).toEqual(["Wandertag 5b"]);
    expect(extractor.requests, "the message is read by the LLM once").toHaveLength(1);
    expect(await instance.app.extraction.waiting(), "no copy waits to be read").toBe(0);
  });

  it("does not read a copy that arrives after its Items were written", async () => {
    testPluginControls.emitFor("mail", mias, [mail()]);
    await run();
    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();

    expect(await titles()).toEqual(["Wandertag 5b"]);
    expect(extractor.requests).toHaveLength(1);
    expect(await instance.app.extraction.waiting()).toBe(0);
  });

  it("does not bring back an Item an Admin deleted when a copy arrives later", async () => {
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
    await mailbox("chat", "chat.example.org");
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

  it("lets its Items concern everyone any copy concerns", async () => {
    testPluginControls.emitFor("mail", mias, [mail()]);
    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();
    await assignInbox(miasMailbox, [mia]);
    await assignInbox(leosMailbox, [leo]);

    expect(await concerning()).toEqual(["Wandertag 5b: Mia, Leo"]);
    expect(await titles([mia])).toEqual(["Wandertag 5b"]);
    expect(await titles([leo])).toEqual(["Wandertag 5b"]);
  });

  it("lets its Items concern the whole Family when the inbox of one copy is assigned to no one", async () => {
    testPluginControls.emitFor("mail", mias, [mail()]);
    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();
    await assignInbox(miasMailbox, [mia]);

    expect(await concerning()).toEqual(["Wandertag 5b: Family"]);
  });

  describe("when Mia's mailbox delivered it first and Leo's later", () => {
    beforeEach(async () => {
      testPluginControls.emitFor("mail", mias, [mail()]);
      await run();
      testPluginControls.emitFor("mail", leos, [mail()]);
      await run();
      await assignInbox(miasMailbox, [mia]);
      await assignInbox(leosMailbox, [leo]);
    });

    it("keeps its Items while one copy remains, and deletes them with the last", async () => {
      testPluginControls.emitFor("mail", mias, [], [mail().externalId]);
      await run();
      expect(await concerning(), "the copy that was read is gone").toEqual(["Wandertag 5b: Leo"]);

      testPluginControls.emitFor("mail", leos, [], [mail().externalId]);
      await run();
      expect(await concerning()).toEqual([]);
    });

    it("keeps its Items when the copy that was not read is withdrawn", async () => {
      testPluginControls.emitFor("mail", leos, [], [mail().externalId]);
      await run();

      expect(await concerning()).toEqual(["Wandertag 5b: Mia"]);
    });

    it("keeps its Items when the Source of the copy that was read is removed", async () => {
      await instance.app.sources.remove(miasMailbox);

      expect(await concerning()).toEqual(["Wandertag 5b: Leo"]);
    });

    it("names each copy as a message of its Items, and shows the Items with each copy", async () => {
      const [item] = (await rows()).items;
      expect(item?.messages).toHaveLength(2);

      for (const message of item!.messages) {
        const opened = await instance.app.messages.open(message.id);
        expect(opened?.items.map((written) => written.id)).toEqual([item!.itemId]);
      }
    });

    it("shows its Items while the Source of one copy is shown", async () => {
      await instance.app.sources.setShown(miasMailbox, false);
      const [item] = (await rows()).items;
      expect(item?.title).toBe("Wandertag 5b");
      expect(item?.messages, "only the copy of the Source that is shown").toHaveLength(1);

      await instance.app.sources.setShown(leosMailbox, false);
      expect(await titles()).toEqual([]);
    });
  });

  it("keeps the content and the row of every copy for as long as the Items need the message", async () => {
    const days = 24 * 60 * minutes;
    testPluginControls.emitFor("mail", mias, [mail()]);
    await run();
    testPluginControls.emitFor("mail", leos, [mail()]);
    await run();
    const [item] = (await rows()).items;

    expect(await instance.app.retention.purge(), "the Wandertag is still to come").toEqual({ purged: 0, deleted: 0 });

    instance.clock.advance(6 * days);
    expect(await instance.app.retention.purge(), "the Wandertag is over").toEqual({ purged: 2, deleted: 0 });

    instance.clock.advance(180 * days);
    expect(await instance.app.retention.purge(), "the Item still points to the message").toEqual({ purged: 0, deleted: 0 });

    await instance.app.messages.deleteItem(item!.itemId);
    expect(await instance.app.retention.purge()).toEqual({ purged: 0, deleted: 2 });
  });

  it("reads a copy that arrives when every earlier copy is withdrawn", async () => {
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
});
