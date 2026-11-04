import type { FamilyMemberId, SourceId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignSource } from "../support/assign";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls } from "../support/test-source-plugin";

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
  const attributes = async () => (await instance.app.sources.list()).find((listed) => listed.id === source)?.attributes ?? [];
  const concerns = async () => (await attributes()).map((attribute) => attribute.concerns);

  /** The Source reports a Source Attribute named School, as its plugin does when it runs. */
  const declared = async () => {
    testPluginControls.declare("assigned-cal", [{ externalId: "school", name: "School" }]);
    await instance.app.polling.pollDue();
    return (await attributes())[0]!.id;
  };

  it("offers nothing to assign before the Source has reported a Source Attribute", async () => {
    expect(await page()).not.toContain('type="checkbox"');
  });

  it("offers each Family Member for each Source Attribute, none chosen for the whole Family", async () => {
    const id = await declared();
    const shown = await page();
    expect(shown).toContain("School");
    expect(shown).toMatch(new RegExp(`<input type="checkbox" name="member.${id}" value="[^"]+"/>`));
    expect(shown).toContain("Mia");
    expect(shown).toContain("With no one chosen, it concerns the whole Family.");
  });

  it("assigns the Source Attribute to the chosen Family Members, and to no one again", async () => {
    const id = await declared();
    const assigned = await instance.post(`/admin/sources/${source}/attributes`, { [`member.${id}`]: mia }, { cookie });
    expect(assigned.status).toBe(303);
    expect(await concerns()).toEqual([[mia]]);
    expect(await page()).toMatch(new RegExp(`<input type="checkbox" name="member.${id}" value="[^"]+" checked=""/>`));

    await instance.post(`/admin/sources/${source}/attributes`, {}, { cookie });
    expect(await concerns()).toEqual([[]]);
  });

  it("names whom a Source concerns in its row", async () => {
    await declared();
    await assignSource(instance, source, [mia]);
    const rows = await (await instance.get("/admin/source-types/assigned-cal", { cookie })).text();
    expect(rows).toContain("Mia");
  });

  it("warns beside the Source Status of Source Attributes it named without reporting them", async () => {
    testPluginControls.emit(
      "assigned-cal",
      [{ externalId: "e1", attributes: ["ghost"], content: { kind: "stated", stated: { kind: "event", title: "x", span: { allDay: true, firstDay: "2026-09-15", lastDay: "2026-09-15" }, place: null, cancelled: false } } }],
      { declaring: false },
    );
    await instance.app.polling.pollDue();

    expect(await page()).toContain("it never reported (ghost)");
  });

  it("has no Attribution Rules page any more", async () => {
    expect((await instance.get("/admin/attribution-rules", { cookie })).status).toBe(404);
  });

  it("keeps assigning to signed-in Admins", async () => {
    const id = await declared();
    const response = await instance.post(`/admin/sources/${source}/attributes`, { [`member.${id}`]: mia });
    expect(response.status).toBe(302);
    expect(await concerns()).toEqual([[]]);
  });
});
