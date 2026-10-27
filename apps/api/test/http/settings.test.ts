import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";

const password = "correct horse battery";

/** The open dialog of a page, from `<dialog` to `</dialog>`; empty if none is open. */
const dialogOf = (page: string) => /<dialog open=""[^>]*>.*?<\/dialog>/s.exec(page)?.[0] ?? "";

/** The settings list's entry for a section, from its link to the link's end. */
const entryOf = (page: string, label: string) =>
  new RegExp(`<a class="fam-navitem"[^>]*>(?:(?!</a>).)*${label}(?:(?!</a>).)*</a>`, "s").exec(page)?.[0] ?? "";

describe("the settings in the Admin area", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  beforeEach(async () => {
    instance = await bootHttpForTest(
      {},
      { sourcePlugins: [{ sourceTypeId: "calendar", displayName: "Calendar" }, { sourceTypeId: "mailbox", displayName: "Mailbox" }] },
    );
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
  });
  afterEach(async () => {
    await instance.close();
  });

  const get = async (path: string) => (await instance.get(path, { cookie })).text();

  it("lists every section with what it holds, marking the one shown", async () => {
    await instance.app.familyMembers.add({ name: "Lina" });
    await instance.app.familyMembers.add({ name: "Jonas" });

    const page = await get("/admin/views");

    expect(entryOf(page, "Family Members")).toContain("Lina, Jonas");
    expect(entryOf(page, "Views")).toContain("None yet");
    expect(entryOf(page, "Views")).toContain('aria-current="page"');
    expect(entryOf(page, "Family Members")).not.toContain("aria-current");
    expect(entryOf(page, "LLM endpoint")).toContain("Not set up");
    expect(entryOf(page, "Admins")).toContain("1 Admin");
    expect(entryOf(page, "Recovery Kit")).toContain("Saved");
    expect(entryOf(page, "Source Types")).toContain("New ones are available");
  });

  it("opens the Admin area on the Family Members, without a dialog", async () => {
    const page = await get("/admin");

    expect(entryOf(page, "Family Members")).toContain('aria-current="page"');
    expect(dialogOf(page)).toBe("");
  });

  it("adds a Family Member in a dialog over the list, keeping what was entered when refused", async () => {
    const opened = await get("/admin/family-members/new");
    expect(dialogOf(opened)).toContain('action="/admin/family-members"');
    expect(dialogOf(opened)).toContain('data-close="/admin/family-members"');

    const refused = await instance.post("/admin/family-members", { name: " " }, { cookie });
    expect(refused.status).toBe(400);
    expect(dialogOf(await refused.text())).toContain("Enter a name");

    const added = await instance.post("/admin/family-members", { name: "Ella" }, { cookie });
    expect(added.headers.get("location")).toBe("/admin/family-members");
    expect(dialogOf(await get("/admin/family-members"))).toBe("");
  });

  it("creates a View and adds an Admin in dialogs, showing why either was refused there", async () => {
    expect(dialogOf(await get("/admin/views/new"))).toContain("Create View");
    const farAhead = await instance.post("/admin/views", { horizonDays: "90" }, { cookie });
    expect(dialogOf(await farAhead.text())).toContain("between 1 and 31 days");

    expect(dialogOf(await get("/admin/admins/new"))).toContain("Add Admin");
    const short = await instance.post("/admin/admins", { email: "ben@example.org", password: "short" }, { cookie });
    expect(short.status).toBe(400);
    const dialog = dialogOf(await short.text());
    expect(dialog).toContain("at least 12 characters");
    expect(dialog).toContain('value="ben@example.org"');
  });

  it("adds a Source by choosing among the enabled Source Types, then filling in that one's form", async () => {
    await instance.app.sourceTypes.enable("calendar");
    await instance.app.sourceTypes.enable("mailbox");

    const choosing = dialogOf(await get("/admin/sources/new"));
    expect(choosing).toContain('href="/admin/sources/new?type=calendar"');
    expect(choosing).toContain('href="/admin/sources/new?type=mailbox"');

    const form = dialogOf(await get("/admin/sources/new?type=mailbox"));
    expect(form).toContain("Add Mailbox");
    expect(form).toContain('href="/admin/sources/new"');

    const refused = await instance.post(
      "/admin/sources",
      { sourceTypeId: "mailbox", "plain.url": "", "secret.password": "hunter2", pollIntervalMinutes: "30" },
      { cookie },
    );
    expect(refused.status).toBe(400);
    const again = dialogOf(await refused.text());
    expect(again).toContain("Check URL.");
    expect(again).toContain('value="30"');
    expect(again).not.toContain("hunter2");
  });

  it("goes back to the Sources when no Source Type is enabled or an unknown one is asked for", async () => {
    expect((await instance.get("/admin/sources/new", { cookie })).headers.get("location")).toBe("/admin/sources");
    await instance.app.sourceTypes.enable("calendar");
    expect((await instance.get("/admin/sources/new?type=unknown", { cookie })).headers.get("location")).toBe(
      "/admin/sources/new",
    );
  });
});
