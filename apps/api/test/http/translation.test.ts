import { afterEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";
import { testPluginControls, type TestPluginPackage } from "../support/test-source-plugin";

const password = "correct horse battery";

/** The settings list's entry for a section, from its link to the link's end. */
const entryOf = (page: string, label: string) =>
  new RegExp(`<a class="fam-navitem"[^>]*>(?:(?!</a>).)*${label}(?:(?!</a>).)*</a>`, "s").exec(page)?.[0] ?? "";

describe("the pages in the Family Language", () => {
  let instance: HttpTestInstance;
  let cookie: string;
  afterEach(async () => {
    await instance.close();
  });

  const setUp = async (language: "en" | "de", sourcePlugins: TestPluginPackage[] = []) => {
    instance = await bootHttpForTest({}, { sourcePlugins });
    await instance.post("/setup", { email: "anna@example.org", password, language });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
  };
  const get = async (path: string) => (await instance.get(path, { cookie })).text();

  it("sets up in the language the browser prefers, and signs in in the Family Language", async () => {
    instance = await bootHttpForTest();

    const setup = await (await instance.get("/setup", { headers: { "accept-language": "de-DE,de;q=0.9" } })).text();
    expect(setup).toContain('<html lang="de">');
    expect(setup).toContain("Ersten Admin anlegen");

    const refused = await instance.post("/setup", { email: "anna", password, language: "de" });
    expect(await refused.text()).toContain("Gib eine gültige E-Mail-Adresse ein.");

    await instance.post("/setup", { email: "anna@example.org", password, language: "de" });
    const signIn = await (await instance.get("/admin/sign-in")).text();
    expect(signIn).toContain('<html lang="de">');
    expect(signIn).toContain("Anmelden");
  });

  it("renders the Admin area in German when the Family Language is German", async () => {
    await setUp("de");

    const page = await get("/admin/family-members");

    expect(page).toContain('<html lang="de">');
    expect(page).toContain("<title>Familienmitglieder · Family Agenda</title>");
    expect(page).toContain("Abmelden");
    expect(page).not.toContain("Sign out");
  });

  it("renders the Admin area in English when the Family Language is English", async () => {
    await setUp("en");

    const page = await get("/admin/family-members");

    expect(page).toContain('<html lang="en">');
    expect(page).toContain("<title>Family Members · Family Agenda</title>");
    expect(page).toContain("Sign out");
  });

  it("renders a View and its feed in German when the Family Language is German", async () => {
    await setUp("de", [{ sourceTypeId: "family-cal" }]);
    await instance.app.sourceTypes.enable("family-cal");
    await instance.app.sources.add({ sourceTypeId: "family-cal", plain: { url: "https://calendar.example.org" }, secrets: {} });
    testPluginControls.emit("family-cal", [
      {
        externalId: "trip",
        occurredAt: new Date("2026-09-01T10:00:00Z"),
        attributes: {},
        content: {
          kind: "revisions",
          revisions: [
            { itemKind: "event", itemKey: "trip", action: "create", fields: { title: "Class trip", span: { allDay: true, firstDay: "2026-09-15", lastDay: "2026-09-15" } } },
          ],
        },
      },
    ]);
    await instance.app.polling.pollDue();
    const created = await instance.app.views.create({ preselected: [], horizonDays: 3 });
    if (!created.ok) throw new Error("creating failed");

    const page = await (await instance.get(`/views/${created.id}`)).text();

    expect(page).toContain('<html lang="de">');
    expect(page).toContain("<title>Ansicht · Family Agenda</title>");
    expect(page).toMatch(/<span class="fam-day__name">Heute<\/span>/);
    expect(page).toMatch(/<span class="fam-day__name">Morgen<\/span>/);
    expect(page).toContain("Ganztägig");
    // The day says the date, so the row does not repeat it; the feed does.
    expect(page).not.toContain("Di., 15. Sept., ganztägig");
    expect(page).toContain("Nichts geplant.");
    expect(page).toContain("Frühere Tage");
    expect(page).not.toContain("Today");

    const feed = await (await instance.get(`/views/${created.id}/feed.ics`)).text();
    expect(feed).toContain("ganztägig");
  });

  it.each([
    { language: "en", one: "1 View on the home network", two: "2 Views on the home network", day: "Everyone · 1 day", days: "Everyone · 2 days" },
    { language: "de", one: "1 Ansicht im Heimnetz", two: "2 Ansichten im Heimnetz", day: "Alle · 1 Tag", days: "Alle · 2 Tage" },
  ] as const)("counts in the plural forms of $language", async ({ language, one, two, day, days }) => {
    await setUp(language);
    const views = language === "de" ? "Ansichten" : "Views";

    await instance.app.views.create({ preselected: [], horizonDays: 1 });
    let page = await get("/admin/views");
    expect(entryOf(page, views)).toContain(one);
    expect(page).toContain(day);

    await instance.app.views.create({ preselected: [], horizonDays: 2 });
    page = await get("/admin/views");
    expect(entryOf(page, views)).toContain(two);
    expect(page).toContain(days);
  });

  describe("a Source plugin's texts", () => {
    const multilingual: TestPluginPackage = {
      sourceTypeId: "calendar",
      displayName: { en: "Calendar", de: "Kalender" },
      description: { en: "Reads a calendar.", de: "Liest einen Kalender." },
      riskNotice: { en: "Reads everything.", de: "Liest alles." },
      configuration: `{ version: 1, fields: [{ key: "url", label: { en: "Address", de: "Adresse" }, secret: false, required: true, description: { en: "Where it lives.", fr: "Où il vit." } }] }`,
    };
    const plain: TestPluginPackage = {
      sourceTypeId: "mailbox",
      displayName: "Mailbox",
      description: "Reads a mailbox.",
      riskNotice: "Reads all mail.",
      configuration: `{ version: 1, fields: [{ key: "host", label: "Mail server", secret: false, required: true, description: "Such as imap.example.org." }] }`,
    };

    it("are shown in the Family Language, in English where a language is missing", async () => {
      await setUp("de", [multilingual]);

      const types = await get("/admin/source-types/calendar");
      expect(types).toContain("Kalender");
      expect(types).toContain("Liest einen Kalender.");
      expect(types).toContain("Liest alles.");
      expect(types).toContain("Kalender aktivieren");

      await instance.app.sourceTypes.enable("calendar", { riskAcknowledged: true });
      const form = await get("/admin/sources/new?type=calendar");
      expect(form).toContain("Kalender hinzufügen");
      expect(form).toMatch(/<label for="new-calendar-url">Adresse<\/label>/);
      expect(form).toContain("<small>Where it lives.</small>");

      const refused = await instance.post("/admin/sources", { sourceTypeId: "calendar", pollIntervalMinutes: "" }, { cookie });
      expect(await refused.text()).toContain("Prüfe Adresse.");
    });

    it("are shown in English when the Family Language is English", async () => {
      await setUp("en", [multilingual]);

      const types = await get("/admin/source-types/calendar");
      expect(types).toContain("Reads a calendar.");
      expect(types).toContain("Enable Calendar");
    });

    it("render unchanged under German when they are plain", async () => {
      await setUp("de", [plain]);

      const types = await get("/admin/source-types/mailbox");
      expect(types).toContain("Reads a mailbox.");
      expect(types).toContain("Reads all mail.");
      expect(types).toContain("Mailbox aktivieren");

      await instance.app.sourceTypes.enable("mailbox", { riskAcknowledged: true });
      const form = await get("/admin/sources/new?type=mailbox");
      expect(form).toMatch(/<label for="new-mailbox-host">Mail server<\/label>/);
      expect(form).toContain("<small>Such as imap.example.org.</small>");
    });
  });
});
