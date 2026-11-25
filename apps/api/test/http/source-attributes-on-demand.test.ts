import type { FamilyMemberId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, type HttpTestInstance, signedInCookie } from "../support/http";
import { testPluginControls } from "../support/test-source-plugin";

describe("the Source Attributes of a plugin that names them apart from a run", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  let sourceId: string;
  let mia: FamilyMemberId;
  const inbox = { externalId: "inbox", name: "Inbox" };
  const school = { externalId: "42", name: "Schule" };
  beforeEach(async () => {
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "folders", namesAttributes: true }] });
    await instance.app.recoveryKit.confirm();
    cookie = await signedInCookie(instance);
    await instance.app.sourceTypes.enable("folders");
    const member = await instance.app.familyMembers.add({ name: "Mia" });
    if (!member.ok) throw new Error("adding failed");
    const added = await instance.app.sources.add({ sourceTypeId: "folders", plain: { url: "imap://example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    sourceId = added.id;
    mia = member.id;
  });
  afterEach(async () => {
    testPluginControls.failAsking("folders", null);
    await instance.close();
  });

  const known = async () => (await instance.app.sources.find(sourceId as never))?.attributes ?? [];
  const archivedByName = async () => Object.fromEntries((await known()).map((attribute) => [attribute.name, attribute.archived]));
  const run = async () => {
    instance.clock.advance(15 * 60 * 1000);
    await instance.app.polling.pollDue();
  };
  /** The section as the page fetches it while the plugin names these. */
  const naming = async (declared: { externalId: string; name: string }[]) => {
    testPluginControls.nameAttributes("folders", { declared });
    return (await instance.get(`/admin/sources/${sourceId}/attributes`, { cookie })).text();
  };

  it("shows a spinner in their place and fetches them once the page is shown, before any run", async () => {
    testPluginControls.nameAttributes("folders", { declared: [{ externalId: "42", name: "Schule" }] });
    const page = await (await instance.get(`/admin/sources/${sourceId}`, { cookie })).text();
    expect(page).toContain("Asking the Source for its parts…");
    expect(page).toContain(`hx-get="/admin/sources/${sourceId}/attributes"`);
    expect(testPluginControls.attributesAsked("folders"), "the page itself does not wait for the plugin").toBe(0);

    const section = await (await instance.get(`/admin/sources/${sourceId}/attributes`, { cookie })).text();
    expect(section).toContain("Schule");
    expect(section).toContain('type="checkbox" name="member.');
    expect(testPluginControls.runs("folders")).toEqual([]);
    expect((await instance.app.sources.find(sourceId as never))?.attributes.map((attribute) => attribute.name)).toEqual(["Schule"]);
  });

  it("archives those the plugin no longer names", async () => {
    testPluginControls.nameAttributes("folders", { declared: [{ externalId: "42", name: "Schule" }] });
    await instance.get(`/admin/sources/${sourceId}/attributes`, { cookie });
    testPluginControls.nameAttributes("folders", { declared: [], archived: ["42"] });
    const section = await (await instance.get(`/admin/sources/${sourceId}/attributes`, { cookie })).text();
    expect(section).not.toContain("Schule");
    expect((await known())[0]).toMatchObject({ externalId: "42", archived: true });
  });

  it("archives one that no run declared once the plugin no longer names it, though it does not archive it", async () => {
    await naming([inbox, school]);
    const section = await naming([school]);
    expect(section).not.toContain("Inbox");
    expect(await archivedByName()).toEqual({ Inbox: true, Schule: false });
  });

  it("archives one that was revived apart from a run", async () => {
    testPluginControls.declare("folders", [inbox]);
    await run();
    testPluginControls.archive("folders", ["inbox"]);
    await run();

    expect(await naming([inbox])).toContain("Inbox");
    await naming([]);
    expect(await archivedByName()).toEqual({ Inbox: true });
  });

  it("keeps one that a run declared until the plugin archives it", async () => {
    await naming([inbox]);
    testPluginControls.declare("folders", [inbox]);
    await run();
    await naming([inbox]);

    expect(await naming([])).toContain("Inbox");
    expect(await archivedByName()).toEqual({ Inbox: false });
  });

  it("keeps the assignment of an archived one when the others are assigned", async () => {
    await naming([inbox, school]);
    const [hidden] = await known();
    await instance.app.sources.assignAttribute(hidden!.id, [mia]);
    await naming([school]);

    await instance.post(`/admin/sources/${sourceId}/attributes`, {}, { cookie });
    expect((await known())[0]).toMatchObject({ externalId: "inbox", archived: true, concerns: [mia] });
  });

  it("says when the plugin names none", async () => {
    const section = await naming([]);
    expect(section).toContain("The Source names no parts it could concern.");
  });

  it("keeps those known so far when asking the plugin fails", async () => {
    testPluginControls.nameAttributes("folders", { declared: [{ externalId: "42", name: "Schule" }] });
    await instance.get(`/admin/sources/${sourceId}/attributes`, { cookie });
    testPluginControls.failAsking("folders", "The mail server is down.");
    const section = await (await instance.get(`/admin/sources/${sourceId}/attributes`, { cookie })).text();
    expect(section).toContain("The mail server is down.");
    expect(section).toContain("Schule");
  });

  it("answers 404 for an unknown Source", async () => {
    const answer = await instance.get("/admin/sources/00000000-0000-0000-0000-000000000000/attributes", { cookie });
    expect(answer.status).toBe(404);
  });
});
