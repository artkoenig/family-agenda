import { afterEach, describe, expect, it } from "vitest";
import type { Notice } from "../../src/http/notice";
import { bootHttpForTest, signedInCookie, type HttpTestInstance } from "../support/http";

const notice: Notice = {
  text: { en: 'Trial until 8 December <b>&</b> "then"', de: "Testzeitraum bis 8. Dezember <script>alert(1)</script>" },
  admin: { text: { en: "Order now", de: "Jetzt <i>bestellen</i>" }, href: "https://operator.example.org/order?plan=monthly&from=trial" },
};

/** The banner of a page, or an empty text for none. */
const bannerOf = (page: string) => /<aside class="fam-notice"[\s\S]*?<\/aside>/.exec(page)?.[0] ?? "";

describe("the notice from the Context", () => {
  let instance: HttpTestInstance;
  afterEach(async () => {
    await instance.close();
  });

  /** Every kind of page the core renders for the Family, each with the notice given to its request. */
  const pagesOf = async (language: "en" | "de", given: Notice | undefined) => {
    await instance.app.languages.setLanguage(language);
    await instance.app.recoveryKit.confirm();
    const cookie = await signedInCookie(instance);
    const timeline = await instance.app.agendas.create({ memberIds: [], horizonDays: 3 });
    const tasks = await instance.app.agendas.create({ memberIds: [], horizonDays: 3, layout: "task_list" });
    if (!timeline.ok || !tasks.ok) throw new Error("creating the Agendas failed");
    const text = async (path: string, signedIn: boolean) =>
      (await instance.get(path, { ...(signedIn ? { cookie } : {}), ...(given ? { notice: given } : {}) })).text();
    return {
      admin: await text("/admin/family-members", true),
      display: await text("/admin/display", true),
      signIn: await text("/admin/sign-in", false),
      timeline: await text(`/agendas/${timeline.id}`, false),
      taskList: await text(`/agendas/${tasks.id}`, false),
      // An Admin opening an Agenda is a reader there: the Agenda shows no Admin area.
      timelineOfAnAdmin: await text(`/agendas/${timeline.id}`, true),
    };
  };

  it("shows no banner on any page without one", async () => {
    instance = await bootHttpForTest();
    for (const page of Object.values(await pagesOf("en", undefined))) expect(page).not.toContain("fam-notice");
  });

  it("shows its text on every page, in the Family Language, escaped", async () => {
    instance = await bootHttpForTest();
    const pages = await pagesOf("de", { text: notice.text });
    for (const page of Object.values(pages)) {
      expect(bannerOf(page)).toContain("Testzeitraum bis 8. Dezember &lt;script&gt;alert(1)&lt;/script&gt;");
      expect(page).not.toContain("<script>alert(1)");
      expect(page).not.toContain("Trial until");
    }
    // At the very top, before anything else of the page.
    expect(pages.admin).toMatch(/<body class="fam-page">\s*<aside class="fam-notice"/);
    expect(pages.timeline).toMatch(/<body class="fam-page fam-agenda">\s*<aside class="fam-notice"/);
  });

  it("shows its text in English for an English Family", async () => {
    instance = await bootHttpForTest();
    const pages = await pagesOf("en", { text: notice.text });
    expect(bannerOf(pages.timeline)).toContain("Trial until 8 December &lt;b&gt;&amp;&lt;/b&gt; &quot;then&quot;");
    expect(pages.timeline).not.toContain("Testzeitraum");
  });

  it("links the Admins' part only on the pages of a signed-in Admin", async () => {
    instance = await bootHttpForTest();
    const pages = await pagesOf("de", notice);
    const link = '<a href="https://operator.example.org/order?plan=monthly&amp;from=trial">Jetzt &lt;i&gt;bestellen&lt;/i&gt;</a>';
    for (const page of [pages.admin, pages.display]) expect(bannerOf(page)).toContain(link);
    for (const page of [pages.signIn, pages.timeline, pages.taskList, pages.timelineOfAnAdmin]) {
      expect(bannerOf(page)).toContain("Testzeitraum");
      expect(page).not.toContain("operator.example.org");
      expect(page).not.toContain("bestellen");
    }
  });
});
