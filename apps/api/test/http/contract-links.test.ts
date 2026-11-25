import { afterEach, describe, expect, it } from "vitest";
import type { ContractLink } from "../../src/http/contract-links";
import { bootHttpForTest, bootHttpForTestBelow, signedInCookie, type HttpTestInstance } from "../support/http";

const all: [ContractLink, ContractLink, ContractLink] = [
  { kind: "cancel", url: "https://operator.example.org/cancel?from=app&lang=auto#top" },
  { kind: "withdraw", url: "https://operator.example.org/withdraw" },
  { kind: "delete", url: "http://operator.example.org/delete" },
];
const [cancel, withdraw, remove] = all;

const german = { cancel: "Verträge hier kündigen", withdraw: "Vertrag widerrufen", delete: "Familie löschen" };

/** The sections of the Admin area, and dialogs over them. */
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

/** The contract links of a page, as label and address, in the order it shows them. */
const contractLinksOf = (page: string) => {
  const part = /<nav class="fam-contract"[\s\S]*?<\/nav>/.exec(page)?.[0] ?? "";
  return [...part.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(([, url, label]) => `${label} ${url?.replaceAll("&amp;", "&")}`);
};

describe("the operator's contract pages", () => {
  let instance: HttpTestInstance;
  afterEach(async () => {
    await instance.close();
  });

  const signIn = async (language: "en" | "de") => {
    await instance.app.languages.setLanguage(language);
    await instance.app.recoveryKit.confirm();
    const cookie = await signedInCookie(instance);
    return async (path: string) => {
      const response = await instance.get(path, { headers: { cookie } });
      expect(response.status, path).toBe(200);
      return response.text();
    };
  };

  it("are not shown, nor any heading, when none is configured", async () => {
    instance = await bootHttpForTest();
    const page = await signIn("en");
    for (const path of adminPaths) {
      const html = await page(path);
      expect(html).not.toContain("fam-contract");
      expect(html).toContain('</header><div class="fam-settings">');
    }
  });

  it.each(all)("$kind alone is linked from every Admin page, and nothing else is", async (link) => {
    instance = await bootHttpForTest({ contractLinks: [link] });
    const page = await signIn("de");
    for (const path of adminPaths) expect(contractLinksOf(await page(path)), path).toEqual([`${german[link.kind]} ${link.url}`]);
  });

  it("keep the statutory German labels for an English Family, marked as German, and translate deletion", async () => {
    instance = await bootHttpForTest({ contractLinks: all });
    const html = await (await signIn("en"))("/admin");
    expect(contractLinksOf(html)).toEqual([`Verträge hier kündigen ${cancel.url}`, `Vertrag widerrufen ${withdraw.url}`, `Delete family ${remove.url}`]);
    expect(html).toContain(`<a href="${withdraw.url}" lang="de">`);
    expect(html).toContain(`<a href="${remove.url}">`);
  });

  it("open in the same tab, also while the Recovery Kit is not confirmed yet", async () => {
    instance = await bootHttpForTest({ contractLinks: all });
    await instance.app.languages.setLanguage("de");
    const cookie = await signedInCookie(instance);
    const html = await (await instance.get("/admin/recovery-kit", { headers: { cookie } })).text();
    expect(contractLinksOf(html)).toHaveLength(3);
    expect(html).not.toMatch(/<nav class="fam-contract"[\s\S]*?target=[\s\S]*?<\/nav>/);
  });

  it("link the configured addresses as given below a path prefix", async () => {
    const below = await bootHttpForTestBelow("/agenda", { contractLinks: all });
    instance = below;
    await below.app.recoveryKit.confirm();
    const cookie = await signedInCookie(below);
    const html = await (await below.get("/agenda/admin/family-members", { headers: { cookie } })).text();
    expect(contractLinksOf(html).map((link) => link.split(" ").at(-1))).toEqual(all.map((link) => link.url));
  });
});
