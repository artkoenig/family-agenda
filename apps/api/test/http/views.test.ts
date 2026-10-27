import type { FamilyMemberId, ViewId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { photos } from "../support/photos";

const password = "correct horse battery";

describe("Views over HTTP", () => {
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

  const createView = async (preselected: FamilyMemberId[]) => {
    const created = await instance.app.views.create({ preselected, horizonDays: 2 });
    if (!created.ok) throw new Error("creating failed");
    return created.id;
  };

  const signIn = async () => {
    const response = await instance.post("/admin/sign-in", { email: "anna@example.org", password });
    return sessionCookieOf(response);
  };

  /** The quick filter's link for a Family Member, or for "All". */
  const filterLink = (page: string, label: string) =>
    new RegExp(`<a[^>]*class="fam-filter__item[^"]*"[^>]*>(?:(?!</a>).)*${label}</a>`, "s").exec(page)?.[0] ?? "";

  it("opens a View without a session, as an empty timeline from now to its horizon", async () => {
    const view = await createView([mia]);

    const response = await instance.get(`/views/${view}`);

    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Today");
    expect(page).toContain("Tomorrow");
    expect(page).toContain("Now 09:00");
    expect(page).toContain("Nothing planned.");
    expect(filterLink(page, "Mia")).toContain('aria-current="true"');
    expect(filterLink(page, "Leo")).not.toContain("aria-current");
    expect(filterLink(page, "All")).not.toContain("aria-current");
    expect(filterLink(page, "Mia")).toContain(`<img src="/family-members/${mia}/photo"`);
    expect(filterLink(page, "Leo")).toContain(">L</span>");
  });

  it("answers an unknown View URL with 404", async () => {
    for (const id of ["3f0b2a52-0000-4000-8000-000000000000", "kitchen"]) {
      expect((await instance.get(`/views/${id}`)).status).toBe(404);
    }
    const view = await createView([]);
    await instance.app.views.remove(view);
    expect((await instance.get(`/views/${view}`)).status).toBe(404);
  });

  it("combines Family Members in the quick filter, and answers htmx with just the timeline", async () => {
    const view = await createView([mia]);

    const page = await (await instance.get(`/views/${view}`)).text();
    const addLeo = /href="([^"]+)"/.exec(filterLink(page, "Leo"))?.[1]?.replaceAll("&amp;", "&");
    expect(addLeo).toBeDefined();

    const response = await instance.get(addLeo!, { headers: { "hx-request": "true" } });

    expect(response.status).toBe(200);
    const fragment = await response.text();
    expect(fragment).not.toContain("<html");
    expect(filterLink(fragment, "Mia")).toContain('aria-current="true"');
    expect(filterLink(fragment, "Leo")).toContain('aria-current="true"');

    const all = await (await instance.get(`/views/${view}?show=all`)).text();
    expect(filterLink(all, "All")).toContain('aria-current="true"');
    expect(filterLink(all, "Mia")).not.toContain("aria-current");
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

  it("lets an Admin add a Family Member with a photo and create a View for them", async () => {
    const cookie = await signIn();
    const form = new FormData();
    form.set("name", "Ella");
    form.set("photo", new File([photos.jpeg], "ella.jpg", { type: "image/jpeg" }));

    const added = await instance.request("/admin/family-members", { body: form, cookie });
    expect(added.status).toBe(303);
    const ella = (await instance.app.familyMembers.list()).find((member) => member.name === "Ella");
    expect(ella?.hasPhoto).toBe(true);

    const created = await instance.post(
      "/admin/views",
      { preselected: ella!.id, horizonDays: "5" },
      { cookie },
    );
    expect(created.status).toBe(303);
    const [view] = await instance.app.views.list();
    expect(view).toMatchObject({ preselected: [ella!.id], horizonDays: 5 });

    const views = await (await instance.get("/admin/views", { cookie })).text();
    expect(views).toContain(`href="/views/${view!.id}"`);
  });

  it("shows an Admin why a Family Member or View cannot be saved", async () => {
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

    const farAhead = await instance.post("/admin/views", { horizonDays: "90" }, { cookie });
    expect(farAhead.status).toBe(400);
    expect(await farAhead.text()).toContain("between 1 and 31 days");
  });

  it("keeps the Family Member and View pages to signed-in Admins", async () => {
    for (const path of ["/admin/family-members", "/admin/views"]) {
      expect((await instance.get(path)).headers.get("location")).toBe("/admin/sign-in");
    }
    const view = "3f0b2a52-0000-4000-8000-000000000000" as ViewId;
    const post = await instance.post(`/admin/views/${view}/remove`, {});
    expect(post.headers.get("location")).toBe("/admin/sign-in");
  });
});
