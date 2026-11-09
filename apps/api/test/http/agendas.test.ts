import type { FamilyMemberId, AgendaId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { assignSource } from "../support/assign";
import { photos } from "../support/photos";

const password = "correct horse battery";

describe("Agendas over HTTP", () => {
  let instance: HttpTestInstance;
  let mia: FamilyMemberId;
  let leo: FamilyMemberId;
  beforeEach(async () => {
    instance = await bootHttpForTest();
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    mia = await addMember("Mia", photos.png);
    leo = await addMember("Leo");
  });
  afterEach(async () => {
    await instance.close();
  });

  const addMember = async (name: string, photo?: Uint8Array) => {
    const added = await instance.app.familyMembers.add({ name, ...(photo ? { photo } : {}) });
    if (!added.ok) throw new Error("adding failed");
    return added.id;
  };

  const createAgenda = async (memberIds: FamilyMemberId[]) => {
    const created = await instance.app.agendas.create({ memberIds, horizonDays: 2 });
    if (!created.ok) throw new Error("creating failed");
    return created.id;
  };

  const signIn = async () => {
    const response = await instance.post("/admin/sign-in", { email: "anna@example.org", password });
    return sessionCookieOf(response);
  };

  /** The quick filter's link for a Family Member, or for "All". */
  const filterLink = (page: string, label: string) =>
    new RegExp(`<a[^>]*class="fam-filter__item[^"]*"[^>]*>(?:(?!</a>).)*${label}</span></a>`, "s").exec(page)?.[0] ?? "";

  it("opens an Agenda without a session, as an empty timeline from now to its horizon", async () => {
    const agenda = await createAgenda([]);

    const response = await instance.get(`/agendas/${agenda}?show=${mia}`);

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Today");
    expect(page).toContain("Tomorrow");
    expect(page).toContain("Nothing planned.");
    expect(filterLink(page, "Mia")).toContain('aria-current="true"');
    expect(filterLink(page, "Leo")).not.toContain("aria-current");
    expect(filterLink(page, "All")).not.toContain("aria-current");
    expect(filterLink(page, "Mia")).toContain(`<img src="/family-members/${mia}/photo"`);
    expect(filterLink(page, "Leo")).toContain(">L</span>");
  });

  it("offers a way back to today, hidden until today scrolls out of sight", async () => {
    const agenda = await createAgenda([]);

    const page = await (await instance.get(`/agendas/${agenda}`)).text();

    const back = /<button[^>]*id="back-to-today"[^>]*>(?:(?!<\/button>).)*<\/button>/s.exec(page)?.[0] ?? "";
    expect(back).toContain("hidden");
    expect(back).toContain("Today");
    expect(page.indexOf("back-to-today")).toBeGreaterThan(page.indexOf("</main>"));
  });

  it("answers an unknown Agenda URL with 404", async () => {
    for (const id of ["3f0b2a52-0000-4000-8000-000000000000", "kitchen"]) {
      expect((await instance.get(`/agendas/${id}`)).status).toBe(404);
    }
    const agenda = await createAgenda([]);
    await instance.app.agendas.remove(agenda);
    expect((await instance.get(`/agendas/${agenda}`)).status).toBe(404);
  });

  it("combines Family Members in the quick filter, and answers htmx with just the timeline", async () => {
    const agenda = await createAgenda([]);

    const page = await (await instance.get(`/agendas/${agenda}?show=${mia}`)).text();
    const addLeo = /href="([^"]+)"/.exec(filterLink(page, "Leo"))?.[1]?.replaceAll("&amp;", "&");
    expect(addLeo).toBeDefined();

    const response = await instance.get(addLeo!, { headers: { "hx-request": "true" } });

    expect(response.status).toBe(200);
    const fragment = await response.text();
    expect(fragment).not.toContain("<html");
    expect(filterLink(fragment, "All")).toContain('aria-current="true"');

    const all = await (await instance.get(`/agendas/${agenda}?show=all`)).text();
    expect(filterLink(all, "All")).toContain('aria-current="true"');
    expect(filterLink(all, "Mia")).not.toContain("aria-current");
  });

  it("offers in the quick filter only the Family Members the Agenda is for, and none for just one", async () => {
    await addMember("Ben");
    const kitchen = await createAgenda([mia, leo]);
    const forMia = await createAgenda([mia]);

    const kitchenPage = await (await instance.get(`/agendas/${kitchen}`)).text();
    expect(filterLink(kitchenPage, "All")).toContain('aria-current="true"');
    expect(filterLink(kitchenPage, "Mia")).not.toBe("");
    expect(filterLink(kitchenPage, "Leo")).not.toBe("");
    expect(filterLink(kitchenPage, "Ben")).toBe("");

    const miaPage = await (await instance.get(`/agendas/${forMia}`)).text();
    expect(miaPage).not.toContain('class="fam-filter"');
    expect(miaPage).not.toContain('class="fam-bar__summary"');
  });

  it("serves a Family Member's photo without a session, and 404 without one", async () => {
    const photo = await instance.get(`/family-members/${mia}/photo`);
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(photo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(photos.png);

    expect((await instance.get(`/family-members/${leo}/photo`)).status).toBe(404);
    expect((await instance.get("/family-members/nobody/photo")).status).toBe(404);
  });

  it("lets an Admin add a Family Member with a photo and create an Agenda for them", async () => {
    const cookie = await signIn();
    const form = new FormData();
    form.set("name", "Ella");
    form.set("photo", new File([photos.jpeg], "ella.jpg", { type: "image/jpeg" }));

    const added = await instance.request("/admin/family-members", { body: form, cookie });
    expect(added.status).toBe(303);
    const ella = (await instance.app.familyMembers.list()).find((member) => member.name === "Ella");
    expect(ella?.hasPhoto).toBe(true);

    const created = await instance.post(
      "/admin/agendas",
      { memberIds: ella!.id, horizonDays: "5" },
      { cookie },
    );
    expect(created.status).toBe(303);
    const [agenda] = await instance.app.agendas.list();
    expect(agenda).toMatchObject({ memberIds: [ella!.id], horizonDays: 5 });

    // Its row opens its dialog, which tells where it and its feed are.
    const agendas = await (await instance.get("/admin/agendas", { cookie })).text();
    expect(agendas).toContain(`href="/admin/agendas/${agenda!.id}"`);
    const dialog = await (await instance.get(`/admin/agendas/${agenda!.id}`, { cookie })).text();
    expect(dialog).toMatch(/<dialog open="" class="fam-dialog"/);
    expect(dialog).toMatch(new RegExp(`href="https?://[^/"]+/agendas/${agenda!.id}"`));
    expect(dialog).toMatch(new RegExp(`href="https?://[^/"]+/agendas/${agenda!.id}/feed\\.ics"`));
    expect(dialog).toMatch(new RegExp(`<button[^>]*data-copy="https?://[^/"]+/agendas/${agenda!.id}"`));
  });

  it("shows an Agenda's address under the public URL, if one is set, rather than the host of the request", async () => {
    await instance.close();
    instance = await bootHttpForTest({ publicUrl: "http://192.168.1.10:8080" });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    const id = await createAgenda([]);
    const cookie = await signIn();

    const dialog = await (await instance.get(`/admin/agendas/${id}`, { cookie })).text();
    expect(dialog).toContain(`href="http://192.168.1.10:8080/agendas/${id}"`);
    expect(dialog).toContain(`data-copy="http://192.168.1.10:8080/agendas/${id}/feed.ics"`);
  });

  it("lets an Admin choose a Task List for an Agenda, which its row and dialog name", async () => {
    const cookie = await signIn();
    const blank = await (await instance.get("/admin/agendas/new", { cookie })).text();
    expect(blank).toMatch(/<input type="radio" name="layout" value="timeline" checked=""/);
    expect(blank).toContain('class="fam-field fam-agenda-horizon"');

    const created = await instance.post("/admin/agendas", { layout: "task_list", horizonDays: "7" }, { cookie });
    expect(created.status).toBe(303);
    const [agenda] = await instance.app.agendas.list();
    expect(agenda).toMatchObject({ layout: "task_list", memberIds: [] });

    expect(await (await instance.get("/admin/agendas", { cookie })).text()).toContain("Task List · Everyone");
    const dialog = await (await instance.get(`/admin/agendas/${agenda!.id}`, { cookie })).text();
    expect(dialog).toMatch(/<input type="radio" name="layout" value="task_list" checked=""/);
    const refused = await instance.post(`/admin/agendas/${agenda!.id}`, { layout: "unknown", horizonDays: "7" }, { cookie });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Choose what the Agenda shows");
  });

  it("shows an Admin why a Family Member or Agenda cannot be saved", async () => {
    const cookie = await signIn();

    const unnamed = await instance.post("/admin/family-members", { name: " " }, { cookie });
    expect(unnamed.status).toBe(400);
    expect(await unnamed.text()).toContain("Enter a name");

    const huge = new FormData();
    huge.set("name", "Ella");
    huge.set("photo", new File([new Uint8Array(6 * 1024 * 1024)], "ella.jpg"));
    const tooLarge = await instance.request("/admin/family-members", { body: huge, cookie });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.text()).toContain("at most 5 MB");

    const farAhead = await instance.post("/admin/agendas", { horizonDays: "90" }, { cookie });
    expect(farAhead.status).toBe(400);
    expect(await farAhead.text()).toContain("between 1 and 31 days");
    // A change that is refused shows why in the dialog of what was changed.
    const mia = await instance.app.familyMembers.add({ name: "Mia" });
    const agenda = await instance.app.agendas.create({ memberIds: [], horizonDays: 7 });
    if (!mia.ok || !agenda.ok) throw new Error("adding failed");
    const renamed = await instance.post(`/admin/family-members/${mia.id}`, { name: " " }, { cookie });
    expect(renamed.status).toBe(400);
    const renamedPage = await renamed.text();
    expect(renamedPage).toContain('<dialog open="" class="fam-dialog" aria-labelledby="edit-member-title"');
    expect(renamedPage).toContain("Enter a name");
    const hugeAgain = new FormData();
    hugeAgain.set("name", "Mia");
    hugeAgain.set("photo", new File([new Uint8Array(6 * 1024 * 1024)], "mia.jpg"));
    const tooLargeAgain = await instance.request(`/admin/family-members/${mia.id}`, { body: hugeAgain, cookie });
    expect(tooLargeAgain.status).toBe(413);
    expect(await tooLargeAgain.text()).toContain('aria-labelledby="edit-member-title"');
    const farAheadAgain = await instance.post(`/admin/agendas/${agenda.id}`, { horizonDays: "90" }, { cookie });
    expect(farAheadAgain.status).toBe(400);
    const farAheadPage = await farAheadAgain.text();
    expect(farAheadPage).toContain('aria-labelledby="edit-agenda-title"');
    expect(farAheadPage).toContain("between 1 and 31 days");
  });

  it("tells an Admin which Source Attributes keep a Family Member from being removed", async () => {
    const cookie = await signIn();
    await instance.installPlugin({ sourceTypeId: "calendar" });
    await instance.restart();
    await instance.app.sourceTypes.enable("calendar");
    const added = await instance.app.sources.add({ sourceTypeId: "calendar", plain: { url: "https://calendar.example.org" }, secrets: {} });
    if (!added.ok) throw new Error(`adding failed: ${added.problem}`);
    await instance.app.sources.rename(added.id, "School calendar");
    await assignSource(instance, added.id, [mia]);

    const refused = await instance.post(`/admin/family-members/${mia}/remove`, {}, { cookie });

    expect(refused.status).toBe(400);
    const page = await refused.text();
    expect(page).toContain("Mia is the only one assigned to");
    expect(page).toContain("School calendar: Main");
    expect((await instance.app.familyMembers.list()).map((member) => member.name)).toEqual(["Mia", "Leo"]);
    expect((await instance.post(`/admin/family-members/${leo}/remove`, {}, { cookie })).status).toBe(303);
  });

  it("keeps the Family Member and Agenda pages to signed-in Admins", async () => {
    for (const path of ["/admin/family-members", "/admin/agendas"]) {
      expect((await instance.get(path)).headers.get("location")).toBe("/admin/sign-in");
    }
    const agenda = "3f0b2a52-0000-4000-8000-000000000000" as AgendaId;
    const post = await instance.post(`/admin/agendas/${agenda}/remove`, {});
    expect(post.headers.get("location")).toBe("/admin/sign-in");
  });
});
