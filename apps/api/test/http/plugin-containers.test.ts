import { describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf } from "../support/http";

const password = "correct horse battery";

describe("A Source Type whose plugin container is gone, in the Admin area", () => {
  it("shows as not reachable, with the cause", async () => {
    const instance = await bootHttpForTest({}, { pluginContainers: [{ sourceTypeId: "school-portal", url: "http://127.0.0.1:1" }] });
    try {
      await instance.post("/setup", { email: "anna@example.org", password });
      await instance.app.recoveryKit.confirm();
      const cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));

      expect(await (await instance.get("/admin/sources", { cookie })).text()).toContain("Not reachable");
      const page = await (await instance.get("/admin/source-types/school-portal", { cookie })).text();
      expect(page).toContain("Not reachable: The plugin at http://127.0.0.1:1 is not reachable");
    } finally {
      await instance.close();
    }
  });
});
