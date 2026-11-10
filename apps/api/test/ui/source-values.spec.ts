import { test, expect } from "./support/fixtures";
import { aChoiceField, adminArea, aSource, aSourceForm, aSourceType } from "./support/admin-area";

const chats = aChoiceField("chats", "Chats");
const form = aSourceForm("bridged", [chats]);
const listed = aSource("bridged", { plain: { chats: ["!class:local"] } });
// Only `find` asks the plugin which values its choice fields offer.
const found = { ...listed, choices: { chats: { ok: true as const, value: [{ value: "!class:local", label: "Class 5b" }] } } };

test("a Source's row says its values are loading, then shows the values its plugin offers", async ({ app, page }) => {
  const { url } = await app(
    adminArea({
      sourceTypes: { list: () => Promise.resolve([aSourceType("bridged", "Matrix")]) },
      sources: { listOfType: () => Promise.resolve([listed]), formOf: () => Promise.resolve(form), find: () => Promise.resolve(found), addingsOf: () => [] },
      catalogues: { recordedEntryIds: () => Promise.resolve(new Set<string>()) },
    }),
  );
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/admin/sources/*/values", async (route) => {
    await released;
    await route.continue();
  });

  await page.goto(`${url}/admin/source-types/bridged`);

  const pending = page.locator(".fam-lazy[aria-busy=true]");
  await expect(pending).toContainText("Chats");
  release();
  await expect(page.getByText("Chats: Class 5b")).toBeVisible();
  await expect(pending).toHaveCount(0);
});
