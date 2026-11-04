import type { Origin } from "@family-agenda/source-sdk";
import { openAgendaAccess } from "@family-agenda/application";
import type { AgendaId, FamilyMemberId, SourceId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignSource } from "../support/assign";
import { bootForTest, type TestInstance } from "../support/boot";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { testPluginControls, writeTestPluginPackage } from "../support/test-source-plugin";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

const entry = (key: string, attributes: string[]): Origin => ({
  externalId: key,
  attributes,
  content: { kind: "stated", stated: { kind: "event", title: key, span: { allDay: false, start: "2026-09-15T14:00:00Z", end: "2026-09-15T15:00:00Z" }, place: null, cancelled: false } },
});

const message = (id: string, text: string, attributes: string[]): Origin => ({
  externalId: id,
  occurredAt: new Date("2026-09-14T06:12:00Z"),
  sender: "Frau Berger",
  attributes,
  content: { kind: "raw-message", text, attachments: [] },
});

describe("Source Attributes", () => {
  let instance: TestInstance;
  let extractor: ScriptedExtractor;
  let source: SourceId;
  let mia: FamilyMemberId;
  let agenda: AgendaId;
  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    extractor = new ScriptedExtractor();
    extractor.script("Wandertag", [
      extracted({ title: "Wandertag 5b", date: { day: 18, month: 9, weekday: "friday" }, evidence: "Freitag, 18.09., ist der Wandertag" }),
    ]);
    instance = await bootForTest({ extractor });
    await writeTestPluginPackage(instance.workspacePackages, { sourceTypeId: "mailbox", needsLlm: true });
    await instance.restart();
    await instance.app.sourceTypes.enable("mailbox");
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const added = await instance.app.sources.add({ sourceTypeId: "mailbox", plain: { url: "mail.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    source = added.id;
    const member = await instance.app.familyMembers.add({ name: "Mia" });
    if (!member.ok) throw new Error(`adding failed: ${member.problem}`);
    mia = member.id;
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    agenda = created.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  const run = async () => {
    instance.clock.advance(15 * minutes);
    const report = await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
    return report;
  };

  const listed = async () => (await instance.app.sources.list()).find((candidate) => candidate.id === source);
  const attributes = async () => (await listed())?.attributes.map(({ externalId, name, archived, concerns }) => ({ externalId, name, archived, concerns }));

  const concerning = async () => {
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    return (page?.days ?? []).flatMap((day) => day.items.map((item) => `${item.title}: ${item.concerns === "whole-family" ? "Family" : item.concerns.length}`));
  };

  describe("declared through the port", () => {
    it("are known to the Source once declared, and declaring them again changes nothing", async () => {
      testPluginControls.declare("mailbox", [{ externalId: "inbox", name: "Inbox" }]);
      await run();
      testPluginControls.declare("mailbox", [{ externalId: "inbox", name: "Inbox" }]);
      await run();

      expect(await attributes()).toEqual([{ externalId: "inbox", name: "Inbox", archived: false, concerns: [] }]);
    });

    it("are renamed and revived by declaring a known one again, keeping the Family Members assigned to it", async () => {
      testPluginControls.declare("mailbox", [{ externalId: "inbox", name: "Inbox" }]);
      await run();
      await assignSource(instance, source, [mia]);

      testPluginControls.archive("mailbox", ["inbox"]);
      await run();
      expect(await attributes()).toEqual([{ externalId: "inbox", name: "Inbox", archived: true, concerns: [mia] }]);

      testPluginControls.declare("mailbox", [{ externalId: "inbox", name: "School" }]);
      await run();
      expect(await attributes()).toEqual([{ externalId: "inbox", name: "School", archived: false, concerns: [mia] }]);
    });

    it("ignore archiving an id never declared", async () => {
      testPluginControls.archive("mailbox", ["ghost"]);
      await run();

      expect(await attributes()).toEqual([]);
    });

    it("leave the Items they decided concerning the same Family Members when archived", async () => {
      testPluginControls.emit("mailbox", [entry("Elternabend", ["school"])]);
      await run();
      await assignSource(instance, source, [mia]);
      expect(await concerning()).toEqual(["Elternabend: 1"]);

      testPluginControls.archive("mailbox", ["school"]);
      await run();

      expect((await attributes())?.[0]?.archived).toBe(true);
      expect(await concerning()).toEqual(["Elternabend: 1"]);
    });
  });

  describe("named by an Origin that was not declared", () => {
    it("refuses the Origin, records the others, and warns beside the Source Status", async () => {
      testPluginControls.emit("mailbox", [entry("Elternabend", ["school"]), entry("Training", ["ghost"])], { declaring: false });
      testPluginControls.declare("mailbox", [{ externalId: "school", name: "School" }]);

      const report = await run();

      expect(report.refused).toEqual([{ sourceId: source, attributes: ["ghost"] }]);
      expect(await instance.query("SELECT external_id FROM source_record ORDER BY external_id")).toEqual([{ external_id: "Elternabend" }]);
      expect((await listed())?.health).toMatchObject({ status: "ok", unknownAttributes: ["ghost"] });
      expect(await instance.query("SELECT unknown_attributes_since IS NOT NULL AS since FROM source_run")).toEqual([{ since: true }]);
    });

    it("refuses an Origin naming an archived Source Attribute", async () => {
      testPluginControls.declare("mailbox", [{ externalId: "school", name: "School" }]);
      testPluginControls.archive("mailbox", ["school"]);
      await run();

      testPluginControls.emit("mailbox", [entry("Elternabend", ["school"])], { declaring: false });
      await run();

      expect(await instance.query("SELECT count(*)::int AS n FROM source_record")).toEqual([{ n: 0 }]);
      expect((await listed())?.health.unknownAttributes).toEqual(["school"]);
    });

    it("clears the warning with a run that refuses nothing", async () => {
      testPluginControls.emit("mailbox", [entry("Training", ["ghost"])], { declaring: false });
      await run();
      expect((await listed())?.health.unknownAttributes).toEqual(["ghost"]);

      await run();

      expect((await listed())?.health.unknownAttributes).toEqual([]);
      expect(await instance.query("SELECT unknown_attributes_since FROM source_run")).toEqual([{ unknown_attributes_since: null }]);
    });

    it("clears the warning with a declare that covers the ids, but not with one that covers only some", async () => {
      testPluginControls.emit("mailbox", [entry("Training", ["ghost"]), entry("Match", ["phantom"])], { declaring: false });
      await run();
      expect((await listed())?.health.unknownAttributes).toEqual(["ghost", "phantom"]);

      // A declare clears the ids it covers when it happens, whatever the rest of the run does.
      testPluginControls.emit("mailbox", [entry("Training", ["ghost"]), entry("Match", ["phantom"])], { declaring: false });
      testPluginControls.declare("mailbox", [{ externalId: "ghost", name: "Ghost" }]);
      await run();
      expect((await listed())?.health.unknownAttributes).toEqual(["phantom"]);
      expect(await instance.query("SELECT external_id FROM source_record")).toEqual([{ external_id: "Training" }]);
    });
  });

  describe("of an Origin recorded again", () => {
    it("replace its list without reading a message again, and who its Items concern follows", async () => {
      testPluginControls.emit("mailbox", [message("$m1", "Am Freitag, 18.09., ist der Wandertag der 5b.", ["school"])]);
      await run();
      testPluginControls.declare("mailbox", [{ externalId: "club", name: "Club" }]);
      await run();
      const found = (await listed())?.attributes ?? [];
      const school = found.find((candidate) => candidate.externalId === "school");
      const club = found.find((candidate) => candidate.externalId === "club");
      await instance.app.sources.assignAttribute(school!.id, [mia]);
      expect(await concerning()).toEqual(["Wandertag 5b: 1"]);
      const readings = extractor.requests.length;

      testPluginControls.emit("mailbox", [message("$m1", "Am Freitag, 18.09., ist der Wandertag der 5b.", ["club"])]);
      await run();

      expect(extractor.requests.length, "no LLM call").toBe(readings);
      expect(await instance.query("SELECT a.external_id FROM source_record_attribute ra JOIN source_attribute a ON a.id = ra.attribute_id")).toEqual([
        { external_id: "club" },
      ]);
      expect(club?.concerns).toEqual([]);
      expect(await concerning()).toEqual(["Wandertag 5b: Family"]);
    });

    it("replace the list of an entry stating the same Item", async () => {
      testPluginControls.emit("mailbox", [entry("Elternabend", ["school"])]);
      await run();
      testPluginControls.emit("mailbox", [entry("Elternabend", ["school", "club"])]);
      await run();

      expect(await instance.query("SELECT a.external_id FROM source_record_attribute ra JOIN source_attribute a ON a.id = ra.attribute_id ORDER BY 1")).toEqual([
        { external_id: "club" },
        { external_id: "school" },
      ]);
      expect(await instance.query("SELECT count(*)::int AS n FROM item")).toEqual([{ n: 1 }]);
    });

    it("withdraw it with an empty list, deleting its Items, and revive an entry that comes back", async () => {
      testPluginControls.emit("mailbox", [entry("Elternabend", ["school"])]);
      await run();
      expect(await concerning()).toEqual(["Elternabend: Family"]);

      testPluginControls.emit("mailbox", [entry("Elternabend", [])]);
      await run();
      expect(await concerning()).toEqual([]);
      expect(await instance.query("SELECT withdrawn_at IS NOT NULL AS withdrawn FROM source_record")).toEqual([{ withdrawn: true }]);

      testPluginControls.emit("mailbox", [entry("Elternabend", ["school"])]);
      await run();
      expect(await concerning()).toEqual(["Elternabend: Family"]);
      expect(await instance.query("SELECT withdrawn_at FROM source_record")).toEqual([{ withdrawn_at: null }]);
    });

    it("withdraw a message with an empty list, and ignore an empty list for an Origin never recorded", async () => {
      testPluginControls.emit("mailbox", [message("$m1", "Am Freitag, 18.09., ist der Wandertag der 5b.", ["school"])]);
      await run();
      expect(await concerning()).toEqual(["Wandertag 5b: Family"]);

      testPluginControls.emit("mailbox", [message("$m1", "x", []), message("$unknown", "x", [])]);
      await run();

      expect(await concerning()).toEqual([]);
      expect(await instance.query("SELECT external_id, body FROM source_record")).toEqual([{ external_id: "$m1", body: null }]);
    });
  });
});
