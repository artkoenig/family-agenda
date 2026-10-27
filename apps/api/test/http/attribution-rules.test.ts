import type { FamilyMemberId, SourceId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls } from "../support/test-source-plugin";

const password = "correct horse battery";

describe("Attribution Rules in the Admin area", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  let source: SourceId;
  let mia: FamilyMemberId;
  beforeEach(async () => {
    instance = await bootHttpForTest({}, { sourcePlugins: [{ sourceTypeId: "rules-cal", displayName: "Calendar" }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("rules-cal");
    const added = await instance.app.sources.add({ sourceTypeId: "rules-cal", plain: { url: "https://calendar.example.org" }, secrets: {} });
    if (!added.ok) throw new Error("adding failed");
    source = added.id;
    const member = await instance.app.familyMembers.add({ name: "Mia" });
    if (!member.ok) throw new Error("adding failed");
    mia = member.id;
  });
  afterEach(async () => {
    await instance.close();
  });

  const page = async () => (await instance.get("/admin/attribution-rules", { cookie })).text();

  it("says that without rules every Item concerns the whole Family", async () => {
    const list = await page();
    expect(list).toContain("No Attribution Rules yet. Every Item concerns the whole Family.");
    expect(list).toMatch(/<a class="fam-navitem" href="\/admin\/attribution-rules" aria-current="page">/);
  });

  it("creates a rule from a form that offers the attribute's known values", async () => {
    testPluginControls.knowValues("rules-cal", [{ value: "teacher@school.example", label: "Ms Weber" }]);
    // With one Source and one attribute, creating goes straight to its form.
    const form = await (await instance.get("/admin/attribution-rules/new", { cookie })).text();
    expect(form).toMatch(/<dialog open="" class="fam-dialog"/);
    expect(form).toContain('<option value="teacher@school.example">Ms Weber</option>');
    expect(form).toMatch(/<input[^>]*name="concerns"[^>]*value="whole-family"/);

    const created = await instance.post(
      "/admin/attribution-rules",
      { sourceId: source, attribute: "sender", value: "teacher@school.example", concerns: mia },
      { cookie },
    );

    expect(created.status).toBe(303);
    expect(await instance.app.attributionRules.list()).toMatchObject([{ value: "teacher@school.example", concerns: [mia] }]);
    const list = await page();
    expect(list).toContain("teacher@school.example");
    expect(list).toContain("Mia");
  });

  it("shows why a rule cannot be saved, in its form", async () => {
    const refused = await instance.post("/admin/attribution-rules", { sourceId: source, attribute: "sender", value: "Club" }, { cookie });

    expect(refused.status).toBe(400);
    const body = await refused.text();
    expect(body).toMatch(/<dialog open="" class="fam-dialog"/);
    expect(body).toContain("Choose whom it concerns");
    expect(body).toContain('value="Club"');
  });

  it("edits a rule in its dialog and removes it", async () => {
    const created = await instance.app.attributionRules.create({ sourceId: source, attribute: "sender", value: "Club", concerns: [mia] });
    if (!created.ok) throw new Error("creating failed");

    const dialog = await (await instance.get(`/admin/attribution-rules/${created.id}`, { cookie })).text();
    expect(dialog).toMatch(/<dialog open="" class="fam-dialog"/);
    expect(dialog).toContain('value="Club"');

    const edited = await instance.post(
      `/admin/attribution-rules/${created.id}`,
      { value: "Football club", concerns: "whole-family" },
      { cookie },
    );
    expect(edited.status).toBe(303);
    expect(await instance.app.attributionRules.list()).toMatchObject([{ value: "Football club", concerns: "whole-family" }]);
    expect(await page()).toContain("Whole Family");

    const removed = await instance.post(`/admin/attribution-rules/${created.id}/remove`, {}, { cookie });
    expect(removed.status).toBe(303);
    expect(await instance.app.attributionRules.list()).toEqual([]);
  });

  it("keeps the rules to signed-in Admins", async () => {
    const response = await instance.get("/admin/attribution-rules");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/sign-in");
  });
});
