import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openAgendaAccess } from "@family-agenda/application";
import type { SourceId, AgendaId } from "@family-agenda/domain";
import { FakeHomeserver } from "@family-agenda/source-matrix/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootForTest, type TestInstance } from "../support/boot";
import { InMemoryBlobStore } from "../support/in-memory-blob-store";
import { extracted, ScriptedExtractor } from "../support/scripted-extractor";
import { openTimeline } from "../support/timeline";

const minutes = 60 * 1000;

const matrixPackage = fileURLToPath(new URL("../../../../packages/source-matrix/", import.meta.url));

/**
 * Installs the Matrix plugin as the image does, but reading the Matrix setup of a fake homeserver
 * from the file the worker would write.
 */
async function installMatrixPlugin(instance: TestInstance, homeserver: FakeHomeserver): Promise<void> {
  const directory = join(instance.workspacePackages, "source-matrix");
  await mkdir(directory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(matrixPackage, "package.json"), "utf8")) as {
    familyAgenda: { sourcePlugin: { entry: string } };
  };
  manifest.familyAgenda.sourcePlugin.entry = "./index.ts";
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  const instanceFile = join(directory, "instance.json");
  await writeFile(instanceFile, JSON.stringify(homeserver.instance()));
  await writeFile(
    join(directory, "index.ts"),
    `import { createMatrixPlugin } from ${JSON.stringify(join(matrixPackage, "src/index.ts"))};\n` +
      `import { installedPrograms } from ${JSON.stringify(join(matrixPackage, "src/testing.ts"))};\n` +
      `export default createMatrixPlugin({ instance: ${JSON.stringify(instanceFile)}, timeoutMs: 5000, programs: installedPrograms });\n`,
  );
}

describe("WhatsApp chats read through the Matrix bridge", () => {
  const homeserver = new FakeHomeserver();
  const teacher = homeserver.ghost("4917612345678");
  let instance: TestInstance;
  let source: SourceId;
  let user: string;
  let classGroup: string;
  let agenda: AgendaId;
  beforeAll(() => homeserver.start());
  afterAll(() => homeserver.close());

  beforeEach(async () => {
    // The clock starts on Monday 2026-09-14 at 09:00 in Berlin.
    const extractor = new ScriptedExtractor();
    extractor.script("Wandertag", [
      extracted({ title: "Wandertag 5b", date: { day: 18, month: 9, weekday: "friday" }, evidence: "Freitag, 18.09., ist Wandertag" }),
    ]);
    instance = await bootForTest({ extractor, blobStore: new InMemoryBlobStore() });
    await installMatrixPlugin(instance, homeserver);
    await instance.restart();
    await instance.app.sourceTypes.enable("matrix");
    expect(await instance.app.catalogues.enable("matrix", "whatsapp", { riskAcknowledged: true })).toEqual({ ok: true });
    await instance.app.llmEndpoint.save({ baseUrl: "http://ollama:11434/v1", model: "qwen3.5:9b", apiKey: "" });
    const created = await instance.app.agendas.create({ preselected: [], horizonDays: 7 });
    if (!created.ok) throw new Error(`creating failed: ${created.problem}`);
    agenda = created.id;

    // An Admin adds a WhatsApp Source, links the account by scanning the QR code, and the bridge
    // invites the Source's Matrix user to the class group's portal.
    const added = await instance.app.sources.add({ sourceTypeId: "matrix", plain: { messenger: "whatsapp" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    source = added.id;
    user = homeserver.registeredUsers().at(-1)!;
    expect(await instance.app.sources.setupProgress(source, "login")).toMatchObject({ status: "waiting", qrCode: expect.any(String) as unknown });
    homeserver.setLogin(user, "CONNECTED");
    classGroup = homeserver.createRoom("Klasse 5b Eltern", { [teacher]: "Frau Berger (WA)" });
    homeserver.invite(classGroup, user);
    await run();
    const [listed] = await instance.app.sources.list();
    expect(listed?.choices.chats).toContainEqual({ value: classGroup, label: "Klasse 5b Eltern" });
    expect(await instance.app.sources.edit(source, { plain: { chats: [classGroup] }, secrets: {} })).toEqual({ ok: true });
    await run();
  });
  afterEach(async () => {
    await instance.close();
  });

  async function run() {
    instance.clock.advance(15 * minutes);
    await instance.app.polling.pollDue();
    await instance.app.extraction.extractPending();
  }

  const titles = async () => {
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    return (page?.days ?? []).flatMap((day) => day.items.map((item) => item.title));
  };

  it("turns a message in an allow-listed chat into an Item", async () => {
    homeserver.text(classGroup, teacher, "Liebe Eltern, am Freitag, 18.09., ist Wandertag.", instance.clock.now());

    await run();

    expect(await titles()).toEqual(["Wandertag 5b"]);
    const page = await openTimeline(instance.app, agenda, { access: openAgendaAccess });
    const message = await instance.app.messages.open(page!.days.flatMap((day) => day.items)[0]!.messages[0]!.id);
    expect(message).toMatchObject({ attributes: ["WhatsApp"], subject: "Klasse 5b Eltern", sender: "Frau Berger (WA)" });
  });

  it("ignores messages in chats that are not allow-listed", async () => {
    const family = homeserver.createRoom("Oma (WA)", { [homeserver.ghost("4930111222333")]: "Oma (WA)" }, { direct: true });
    homeserver.invite(family, user);
    await run();

    homeserver.text(family, homeserver.ghost("4930111222333"), "Am Freitag, 18.09., ist Wandertag bei uns im Garten.", instance.clock.now());
    await run();

    expect(await titles()).toEqual([]);
    expect(await instance.query("SELECT count(*)::int AS n FROM source_record")).toEqual([{ n: 0 }]);
  });

  it("takes the Item away once its message is deleted for everyone", async () => {
    const sent = homeserver.text(classGroup, teacher, "Liebe Eltern, am Freitag, 18.09., ist Wandertag.", instance.clock.now());
    await run();
    expect(await titles()).toEqual(["Wandertag 5b"]);

    homeserver.redact(classGroup, sent, instance.clock.now());
    await run();

    expect(await titles()).toEqual([]);
  });

  it("is Failing once the WhatsApp account is logged out, and Fix shows a new QR code", async () => {
    homeserver.setLogin(user, "LOGGED_OUT", "Unlinked from the phone");

    await run();

    const [listed] = await instance.app.sources.list();
    expect(listed?.health).toMatchObject({
      status: "failing",
      problem: { kind: "run-failed", message: expect.stringContaining("The WhatsApp account was logged out") as unknown },
    });
    expect(await instance.app.sources.setupProgress(source, "login")).toMatchObject({ status: "waiting", qrCode: expect.any(String) as unknown });
  });
});
