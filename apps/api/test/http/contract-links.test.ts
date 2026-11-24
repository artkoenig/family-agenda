import { afterEach, describe, expect, it } from "vitest";
import type { ContractLink } from "../../src/http/contract-links";
import { bootHttpForTest, bootHttpForTestBelow, signedInCookie, type HttpTestInstance } from "../support/http";

const cancel: ContractLink = { kind: "cancel", url: "https://operator.example.org/cancel" };
const withdraw: ContractLink = { kind: "withdraw", url: "https://operator.example.org/withdraw?from=admin&x=1" };
const remove: ContractLink = { kind: "delete", url: "http://operator.example.org/delete#family" };
const all = [cancel, withdraw, remove];

/** The pages of the Admin area that the settings list leads to, each through the Admin layout. */
const adminPaths = ["/admin", "/admin/family-members", "/admin/agendas", "/admin/display", "/admin/sources", "/admin/llm", "/admin/recovery-kit"];

/** The contract links of a page, as label and address, in the order it shows them. */
const contractLinksOf = (page: string) => {
  const part = /<span class="fam-settings__group fam-contract">[\s\S]*?<span class="fam-settings__version">/.exec(page)?.[0] ?? "";
  return [...part.matchAll(/<a class="fam-navitem" href="([^"]*)">[\s\S]*?<span class="fam-navitem__label">([^<]*)<\/span>/g)].map(
    ([, url, label]) => `${label} ${url?.replaceAll("&amp;", "&")}`,
  );
};

describe("the operator's contract links in the Admin area", () => {
  let instance: HttpTestInstance;
  afterEach(async () => {
    await instance.close();
  });

  /** Every Admin page, signed in, in the given Family Language. */
  const adminPagesOf = async (language: "en" | "de") => {
    await instance.app.languages.setLanguage(language);
    await instance.app.recoveryKit.confirm();
    const cookie = await signedInCookie(instance);
    return Promise.all(adminPaths.map(async (path) => (await instance.get(path, { cookie })).text()));
  };

  it("are not shown, nor their group, when none is configured, leaving the Admin area as before", async () => {
    instance = await bootHttpForTest();
    for (const page of await adminPagesOf("de")) {
      expect(page).not.toContain("fam-contract");
      expect([...page.matchAll(/<span class="fam-settings__group[^"]*">([^<]*)<\/span>/g)].map(([, name]) => name)).toEqual(["Familie", "Quellen", "Instanz"]);
      // The version still follows the last section straight away.
      expect(page).toMatch(/<\/a><span class="fam-settings__version">/);
    }
  });

  it("are on every Admin page, in their own group of the settings list, linking the addresses unchanged", async () => {
    instance = await bootHttpForTest({ contractLinks: all });
    for (const page of await adminPagesOf("de")) {
      expect(contractLinksOf(page)).toEqual([
        "Verträge hier kündigen https://operator.example.org/cancel",
        "Vertrag widerrufen https://operator.example.org/withdraw?from=admin&x=1",
        "Familie löschen http://operator.example.org/delete#family",
      ]);
      expect(page).toContain('<span class="fam-settings__group fam-contract">Vertrag</span>');
    }
  });

  it("keep the two statutory labels German in an English Family, and translate the delete link", async () => {
    instance = await bootHttpForTest({ contractLinks: all });
    for (const page of await adminPagesOf("en")) {
      expect(contractLinksOf(page).map((link) => link.slice(0, link.lastIndexOf(" ")))).toEqual(["Verträge hier kündigen", "Vertrag widerrufen", "Delete family"]);
      expect(page).toContain('<span class="fam-settings__group fam-contract">Contract</span>');
    }
  });

  it.each([cancel, withdraw, remove])("show only the $kind link when it alone is set", async (link) => {
    instance = await bootHttpForTest({ contractLinks: [link] });
    for (const page of await adminPagesOf("en")) {
      expect(contractLinksOf(page).map((shown) => shown.slice(shown.lastIndexOf(" ") + 1))).toEqual([link.url]);
    }
  });

  it("are not on the pages outside the Admin area", async () => {
    instance = await bootHttpForTest({ contractLinks: all });
    const signIn = await (await instance.get("/admin/sign-in")).text();
    expect(signIn).not.toContain("operator.example.org");
  });

  it("link the configured addresses as given below a path prefix", async () => {
    const below = await bootHttpForTestBelow("/agenda", { contractLinks: all });
    instance = below;
    await below.app.recoveryKit.confirm();
    const cookie = await signedInCookie(below);
    const page = await (await below.get("/agenda/admin/family-members", { cookie })).text();
    expect(contractLinksOf(page).map((link) => link.slice(link.lastIndexOf(" ") + 1))).toEqual(all.map((link) => link.url));
  });
});
