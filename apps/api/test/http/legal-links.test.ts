import { afterEach, describe, expect, it } from "vitest";
import type { LegalLink } from "../../src/http/legal-links";
import { bootHttpForTest, bootHttpForTestBelow, signedInCookie, type HttpTestInstance } from "../support/http";

const all: LegalLink[] = [
  { kind: "imprint", url: "https://operator.example.org/imprint" },
  { kind: "privacy", url: "https://operator.example.org/privacy?lang=auto#top" },
  { kind: "terms", url: "https://operator.example.org/terms" },
];

/** The legal links of a page, as label and address, in the order it shows them. */
const legalLinksOf = (page: string) => {
  const part = /<footer class="fam-legal">[\s\S]*?<\/footer>/.exec(page)?.[0] ?? "";
  return [...part.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map(([, url, label]) => `${label} ${url?.replaceAll("&amp;", "&")}`);
};

describe("the operator's legal pages", () => {
  let instance: HttpTestInstance;
  afterEach(async () => {
    await instance.close();
  });

  /** The pages the issue names, each by what it is: the Admin area, signing in, the Recovery Kit and both kinds of Agenda. */
  const pagesOf = async (language: "en" | "de") => {
    await instance.app.languages.setLanguage(language);
    await instance.app.recoveryKit.confirm();
    const cookie = await signedInCookie(instance);
    const timeline = await instance.app.agendas.create({ memberIds: [], horizonDays: 3 });
    const tasks = await instance.app.agendas.create({ memberIds: [], horizonDays: 3, layout: "task_list" });
    if (!timeline.ok || !tasks.ok) throw new Error("creating the Agendas failed");
    const text = async (path: string, withCookie = true) => (await instance.get(path, withCookie ? { cookie } : {})).text();
    return {
      admin: await text("/admin/family-members"),
      signIn: await text("/admin/sign-in", false),
      recoveryKit: await text("/admin/recovery-kit"),
      timeline: await text(`/agendas/${timeline.id}`),
      taskList: await text(`/agendas/${tasks.id}`),
    };
  };

  it("are not shown, nor any footer, when none is configured", async () => {
    instance = await bootHttpForTest();
    for (const page of Object.values(await pagesOf("en"))) {
      expect(page).not.toContain("fam-legal");
      expect(page).not.toContain("<footer");
    }
  });

  it("are linked from every page but an Agenda, in the Family Language, in one quiet line", async () => {
    instance = await bootHttpForTest({ legalLinks: all });
    const pages = await pagesOf("de");
    const german = ["Impressum https://operator.example.org/imprint", "Datenschutz https://operator.example.org/privacy?lang=auto#top", "AGB https://operator.example.org/terms"];
    for (const page of [pages.admin, pages.signIn, pages.recoveryKit]) {
      expect(legalLinksOf(page)).toEqual(german);
      expect(page).toContain('<footer class="fam-legal">');
      expect(page).toContain("</a><span aria-hidden=\"true\"> · </span><a");
    }
  });

  it("are not shown on an Agenda, of either kind, though configured", async () => {
    instance = await bootHttpForTest({ legalLinks: all });
    const pages = await pagesOf("de");
    for (const page of [pages.timeline, pages.taskList]) {
      expect(page).not.toContain("fam-legal");
      expect(page).not.toContain("<footer");
      for (const link of all) expect(page).not.toContain(link.url.split("?")[0]);
    }
  });

  it("are labelled in English for an English Family", async () => {
    instance = await bootHttpForTest({ legalLinks: all });
    const pages = await pagesOf("en");
    expect(legalLinksOf(pages.signIn).map((link) => link.split(" ")[0])).toEqual(["Imprint", "Privacy", "Terms"]);
  });

  it("shows only those configured, without a stray separator", async () => {
    instance = await bootHttpForTest({ legalLinks: [all[0] as LegalLink] });
    const pages = await pagesOf("de");
    expect(pages.signIn).toContain('<footer class="fam-legal"><a href="https://operator.example.org/imprint">Impressum</a></footer>');
  });

  it("link the configured addresses as given below a path prefix", async () => {
    const below = await bootHttpForTestBelow("/agenda", { legalLinks: all });
    instance = below;
    const signIn = await (await below.get("/agenda/admin/sign-in")).text();
    expect(legalLinksOf(signIn).map((link) => link.split(" ")[1])).toEqual(all.map((link) => link.url));
  });
});
