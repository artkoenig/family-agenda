import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls } from "../support/test-source-plugin";

const password = "correct horse battery";

describe("the Source Attributes of a plugin that names them apart from a run", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  let sourceId: string;
  beforeEach(async () => {
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "folders", namesAttributes: true }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("folders");
    const member = await instance.app.familyMembers.add({ name: "Mia" });
    if (!member.ok) throw new Error("adding failed");
    const added = await instance.app.sources.add({ sourceTypeId: "folders", plain: { url: "imap://example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    sourceId = added.id;
  });
  afterEach(async () => {
    testPluginControls.failAsking("folders", null);
    await instance.close();
  });

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
    expect(section).toContain("Gone from the Source");
  });

  it("says when the plugin names none", async () => {
    const section = await (await instance.get(`/admin/sources/${sourceId}/attributes`, { cookie })).text();
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
