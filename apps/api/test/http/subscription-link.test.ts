import { afterEach, describe, expect, it } from "vitest";
import { bootHttpForTest, bootHttpForTestBelow, signedInCookie, type HttpTestInstance } from "../support/http";

const subscriptionUrl = "https://operator.example.org/subscription?tab=invoices&lang=auto";

/** The pages of the Admin area, a signed-in Admin's, and an Agenda's for a reader. */
const pagesOf = async (instance: HttpTestInstance, language: "en" | "de", base = "") => {
  await instance.app.languages.setLanguage(language);
  await instance.app.recoveryKit.confirm();
  const cookie = await signedInCookie(instance);
  const agenda = await instance.app.agendas.create({ memberIds: [], horizonDays: 3 });
  if (!agenda.ok) throw new Error("creating the Agenda failed");
  const text = async (path: string) => (await instance.get(`${base}${path}`, { cookie })).text();
  return {
    admin: [await text("/admin/family-members"), await text("/admin/sources"), await text("/admin/display")],
    signIn: await (await instance.get(`${base}/admin/sign-in`)).text(),
    agenda: await text(`/agendas/${agenda.id}`),
  };
};

/** The subscription link of a page, as label and address; empty for none. */
const subscriptionLinkOf = (page: string) => {
  const link = /<a class="fam-navitem" id="subscription" href="([^"]*)"[^>]*>[\s\S]*?<span class="fam-navitem__label">([^<]*)<\/span>/.exec(page);
  return link ? `${link[2]} ${link[1]?.replaceAll("&amp;", "&")}` : "";
};

describe("the subscription link in the Admin area", () => {
  let instance: HttpTestInstance;
  afterEach(async () => {
    await instance.close();
  });

  it("is not shown, nor its group, without SUBSCRIPTION_URL", async () => {
    instance = await bootHttpForTest();
    const pages = await pagesOf(instance, "de");
    for (const page of [...pages.admin, pages.signIn, pages.agenda]) {
      expect(page).not.toContain("subscription");
      expect(page).not.toContain("Abonnement");
    }
  });

  it("links the address as given from every page of the Admin area, in the Family Language", async () => {
    instance = await bootHttpForTest({ subscriptionUrl });
    const pages = await pagesOf(instance, "de");
    for (const page of pages.admin) expect(subscriptionLinkOf(page)).toBe(`Abonnement ${subscriptionUrl}`);
    // Signing in and the Agendas belong to no Admin.
    for (const page of [pages.signIn, pages.agenda]) expect(page).not.toContain("operator.example.org");
  });

  it("reads Subscription for an English Family", async () => {
    instance = await bootHttpForTest({ subscriptionUrl });
    const pages = await pagesOf(instance, "en");
    expect(subscriptionLinkOf(pages.admin[0] ?? "")).toBe(`Subscription ${subscriptionUrl}`);
  });

  it("links the configured address below a path prefix, not prefixed", async () => {
    const below = await bootHttpForTestBelow("/agenda", { subscriptionUrl });
    instance = below;
    const pages = await pagesOf(below, "en", "/agenda");
    expect(subscriptionLinkOf(pages.admin[0] ?? "")).toBe(`Subscription ${subscriptionUrl}`);
  });
});
