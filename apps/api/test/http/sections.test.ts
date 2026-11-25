import { afterEach, describe, expect, it } from "vitest";
import type { ContextSection } from "../../src/context/sections";
import { bootHttpForTest, bootHttpForTestBelow, signedInCookie, type HttpTestInstance } from "../support/http";

const contract: ContextSection = {
  id: "contract",
  label: { en: "Contract & <b>bill</b>", de: "Vertrag & <b>Rechnung</b>" },
  src: { en: "https://home.example.org/platform/contract?lang=en&from=app#top", de: "https://home.example.org/platform/vertrag?lang=de&from=app" },
};
const help: ContextSection = { id: "help", label: { en: "Help", de: "Hilfe" }, src: { en: "https://home.example.org/help", de: "https://home.example.org/hilfe" } };

const adminPaths = [
  "/admin",
  "/admin/family-members",
  "/admin/family-members/new",
  "/admin/agendas",
  "/admin/display",
  "/admin/sources",
  "/admin/agendas/new",
  "/admin/llm",
  "/admin/recovery-kit",
];

/** The groups of the settings list of a page, each with its entries as label and address. */
const navigationOf = (html: string) => {
  const nav = /<nav class="fam-settings__nav"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
  return nav.split('<span class="fam-settings__group">').slice(1).map((group) => ({
    name: /^[^<]*/.exec(group)?.[0],
    entries: [...group.matchAll(/<a class="fam-navitem" href="([^"]*)"[\s\S]*?fam-navitem__label">(.*?)<\/span>/g)].map(([, address, label]) => `${label} ${address}`),
  }));
};
const mainOf = (html: string) => /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "";

describe("the platform's sections of the Admin area", () => {
  let instance: HttpTestInstance;
  afterEach(async () => {
    await instance.close();
  });

  const signIn = async (options: { language?: "en" | "de"; subject?: string; kitSaved?: boolean } = {}) => {
    await instance.app.languages.setLanguage(options.language ?? "en");
    if (options.kitSaved !== false) await instance.app.recoveryKit.confirm();
    const cookie = await signedInCookie(instance, { subject: options.subject ?? "sub-anna", email: "anna@example.org" });
    return (path: string) => instance.get(path, { headers: { cookie } });
  };

  it.each([[undefined], [[]]])("add neither an entry nor a group without any", async (sections) => {
    instance = await bootHttpForTest({ sections });
    const get = await signIn();
    for (const path of adminPaths) {
      const html = await (await get(path)).text();
      expect(navigationOf(html).map(({ name }) => name), path).toEqual(["Family", "Sources", "Instance"]);
      expect(html).not.toContain("/admin/sections/");
      expect(html).toContain('</header><div class="fam-settings">');
    }
  });

  it.each([
    ["en", "More", ["Contract &amp; &lt;b&gt;bill&lt;/b&gt;", "Help"]],
    ["de", "Weiteres", ["Vertrag &amp; &lt;b&gt;Rechnung&lt;/b&gt;", "Hilfe"]],
  ] as const)("are entries of a group of their own on every Admin page, in their order, named in %s", async (language, group, [first, second]) => {
    instance = await bootHttpForTest({ sections: [contract, help] });
    const get = await signIn({ language });
    for (const path of adminPaths) {
      expect(navigationOf(await (await get(path)).text()).slice(3), path).toEqual([
        { name: group, entries: [`${first} /admin/sections/contract`, `${second} /admin/sections/help`] },
      ]);
    }
  });

  it.each([
    ["en", "Contract &amp; &lt;b&gt;bill&lt;/b&gt;", "https://home.example.org/platform/contract?lang=en&amp;from=app#top", "Loading…"],
    ["de", "Vertrag &amp; &lt;b&gt;Rechnung&lt;/b&gt;", "https://home.example.org/platform/vertrag?lang=de&amp;from=app", "Wird geladen …"],
  ] as const)("have a page each, titled by its label, which loads the address given for %s", async (language, label, src, loading) => {
    instance = await bootHttpForTest({ sections: [contract, help] });
    const response = await (await signIn({ language }))("/admin/sections/contract");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`<title>${label} · Family Agenda</title>`);
    expect(html).toContain(`href="/admin/sections/contract" aria-current="page"`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    const main = mainOf(html);
    expect(main).toContain(`<h1 class="fam-section-header__title">${label}</h1>`);
    expect(main).toContain(`hx-get="${src}" hx-trigger="load"`);
    expect(main).toContain(loading);
    expect(main.match(/hx-get/g)).toHaveLength(1);
  });

  it("load the address as given below a path prefix too", async () => {
    instance = await bootHttpForTestBelow("/agenda", { sections: [contract] });
    const get = await signIn();
    const html = await (await get("/agenda/admin/sections/contract")).text();
    expect(navigationOf(html).at(-1)?.entries).toEqual(["Contract &amp; &lt;b&gt;bill&lt;/b&gt; /agenda/admin/sections/contract"]);
    expect(mainOf(html)).toContain('hx-get="https://home.example.org/platform/contract?lang=en&amp;from=app#top"');
  });

  it("are shown to the one Admin they are for only, and not found for another or under an unknown id", async () => {
    instance = await bootHttpForTest({ sections: [{ ...contract, onlyFor: "sub-anna" }, help] });
    const anna = await signIn();
    expect(navigationOf(await (await anna("/admin")).text()).at(-1)?.entries).toHaveLength(2);
    expect((await anna("/admin/sections/contract")).status).toBe(200);
    expect((await anna("/admin/sections/unknown")).status).toBe(404);

    const ben = await signIn({ subject: "sub-ben" });
    expect(navigationOf(await (await ben("/admin")).text()).at(-1)?.entries).toEqual(["Help /admin/sections/help"]);
    expect((await ben("/admin/sections/contract")).status).toBe(404);
    expect((await ben("/admin/sections/help")).status).toBe(200);
  });

  it("add no group for an Admin who may see none", async () => {
    instance = await bootHttpForTest({ sections: [{ ...contract, onlyFor: "sub-anna" }] });
    const html = await (await (await signIn({ subject: "sub-ben" }))("/admin")).text();
    expect(navigationOf(html)).toHaveLength(3);
  });

  it("lead to the Recovery Kit and load nothing before it is saved", async () => {
    instance = await bootHttpForTest({ sections: [contract, help] });
    const get = await signIn({ kitSaved: false });
    for (const path of [...adminPaths, "/admin/sections/contract"]) {
      const response = await get(path);
      if (path !== "/admin/recovery-kit") expect(response.headers.get("location"), path).toBe("/admin/recovery-kit");
      const html = await response.text();
      expect(html).not.toContain("home.example.org");
    }
    expect(navigationOf(await (await get("/admin/recovery-kit")).text()).at(-1)?.entries).toHaveLength(2);
  });

  it("ask for a sign-in first", async () => {
    instance = await bootHttpForTest({ sections: [contract] });
    expect((await instance.get("/admin/sections/contract")).headers.get("location")).toBe("/admin/sign-in");
  });
});
