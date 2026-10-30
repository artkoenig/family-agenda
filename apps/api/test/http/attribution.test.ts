import type { FamilyMemberId, SourceId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";

const password = "correct horse battery";

describe("Assigning a Source to Family Members in the Admin area", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  let source: SourceId;
  let mia: FamilyMemberId;
  beforeEach(async () => {
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "assigned-cal", displayName: "Calendar" }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("assigned-cal");
    const added = await instance.app.sources.add({ sourceTypeId: "assigned-cal", plain: { url: "https://calendar.example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    source = added.id;
    const member = await instance.app.familyMembers.add({ name: "Mia" });
    if (!member.ok) throw new Error("adding failed");
    mia = member.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  const page = async () => (await instance.get(`/admin/sources/${source}`, { cookie })).text();
  const concerns = async () => (await instance.app.sources.list()).find((listed) => listed.id === source)?.concerns;

  it("offers each Family Member on the Source's page, none chosen for the whole Family", async () => {
    const shown = await page();
    expect(shown).toMatch(/<input type="checkbox" name="concerns" value="[^"]+"\/>/);
    expect(shown).toContain("Mia");
    expect(shown).toContain("With no one chosen, they concern the whole Family.");
  });

  it("assigns the Source to the chosen Family Members, and to no one again", async () => {
    const assigned = await instance.post(`/admin/sources/${source}/concerns`, { concerns: mia }, { cookie });
    expect(assigned.status).toBe(303);
    expect(await concerns()).toEqual([mia]);
    expect(await page()).toMatch(/<input type="checkbox" name="concerns" value="[^"]+" checked=""\/>/);

    await instance.post(`/admin/sources/${source}/concerns`, {}, { cookie });
    expect(await concerns()).toEqual([]);
  });

  it("names whom a Source concerns in its row", async () => {
    await instance.app.sources.assign(source, [mia]);
    const rows = await (await instance.get("/admin/source-types/assigned-cal", { cookie })).text();
    expect(rows).toContain("Mia");
  });

  it("has no Attribution Rules page any more", async () => {
    expect((await instance.get("/admin/attribution-rules", { cookie })).status).toBe(404);
  });

  it("keeps assigning to signed-in Admins", async () => {
    const response = await instance.post(`/admin/sources/${source}/concerns`, { concerns: mia });
    expect(response.status).toBe(302);
    expect(await concerns()).toEqual([]);
  });
});

describe("Assigning the folders of a Source in the Admin area", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  let mia: FamilyMemberId;
  beforeEach(async () => {
    instance = await bootHttpForTest(
      {},
      {
        sourcePlugins: [
          {
            sourceTypeId: "folder-mail",
            displayName: "Mailbox",
            configuration: `{ version: 1, fields: [{ key: "folders", label: "Folders", secret: false, required: false, parts: true }] }`,
          },
        ],
      },
    );
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("folder-mail");
    const member = await instance.app.familyMembers.add({ name: "Mia" });
    if (!member.ok) throw new Error("adding failed");
    mia = member.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  it("adds a Source with its folders, each assigned to the Family Members chosen, and shows them on its page", async () => {
    const added = await instance.post(
      "/admin/sources",
      {
        sourceTypeId: "folder-mail",
        "part.folders.0.name": "School",
        "part.folders.0.member": mia,
        "part.folders.1.name": "Club",
        "part.folders.2.name": "",
      },
      { cookie },
    );
    expect(added.status).toBe(303);

    const [source] = await instance.app.sources.list();
    expect(source?.partConcerns).toEqual({ School: [mia] });
    expect(await instance.app.sources.forms()).toMatchObject([{ fields: [{ key: "folders", parts: true }] }]);
    const shown = await (await instance.get(`/admin/sources/${source?.id}`, { cookie })).text();
    expect(shown).toContain('value="School"');
    expect(shown).toContain('value="Club"');
    expect(shown).not.toContain(`/admin/sources/${source?.id}/concerns`);
  });
});
