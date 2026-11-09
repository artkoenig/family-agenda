import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { SourceTypeId } from "@family-agenda/domain";
import { PluginError } from "@family-agenda/plugin-kit";
import { servePlugin } from "@family-agenda/plugin-kit/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, sessionCookieOf, type HttpTestInstance } from "../support/http";

const password = "correct horse battery";

describe("The Source wizard for a Source Type whose plugin runs in a container", () => {
  let instance: HttpTestInstance;
  let server: Server;
  let cookie: string;
  let failing: boolean;

  beforeEach(async () => {
    failing = false;
    server = await servePlugin(
      {
        description: {
          sourceTypeId: "school-portal",
          kind: "stateless",
          displayName: { en: "School portal", de: "Schulportal" },
          version: "1.0.0",
          description: "Reads the school portal.",
          needsLlm: false,
          configuration: {
            version: 1,
            fields: [
              { key: "url", label: "Address", secret: false, required: true, hasChoices: false },
              { key: "classes", label: "Classes", secret: false, required: false, hasChoices: true },
            ],
          },
          setupSteps: [],
          ingestion: { mode: "polling", suggestedIntervalSeconds: 600 },
          silentApplies: false,
        },
        poll: () => ({ sourceRecords: [], syncCursor: null }),
        fieldChoices: () => {
          if (failing) throw new PluginError("definite", "The account is signed out.");
          return { choices: [{ value: "3b", label: "Class 3b" }] };
        },
      },
      { host: "127.0.0.1" },
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    instance = await bootHttpForTest({}, { pluginContainers: [{ sourceTypeId: "school-portal" as SourceTypeId, url }] });
    await instance.post("/setup", { email: "anna@example.org", password });
    await instance.app.recoveryKit.confirm();
    cookie = sessionCookieOf(await instance.post("/admin/sign-in", { email: "anna@example.org", password }));
    await instance.app.sourceTypes.enable("school-portal");
  });
  afterEach(async () => {
    await instance.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it("creates a Source, then edits it with the choices its plugin offers", async () => {
    const form = await (await instance.get("/admin/sources/new?type=school-portal", { cookie })).text();
    expect(form).toContain('name="plain.url"');
    expect(form).toContain("Offered once the Source is set up.");

    const added = await instance.post("/admin/sources", { sourceTypeId: "school-portal", "plain.url": "https://portal.example.org" }, { cookie });
    expect(added.status).toBe(303);
    const [source] = await instance.app.sources.list();

    const own = await (await instance.get(`/admin/sources/${source!.id}`, { cookie })).text();
    expect(own).toMatch(/<input type="checkbox" name="choice.classes" value="3b"\/?> Class 3b/);

    const body = new FormData();
    body.append("plain.url", "https://portal.example.org");
    body.append("choice.classes", "");
    body.append("choice.classes", "3b");
    expect((await instance.request(`/admin/sources/${source!.id}`, { body, cookie })).status).toBe(303);
    expect((await instance.app.sources.list())[0]?.plain).toMatchObject({ classes: ["3b"] });
  });

  it("shows why its plugin could not offer choices", async () => {
    await instance.post("/admin/sources", { sourceTypeId: "school-portal", "plain.url": "https://portal.example.org" }, { cookie });
    const [source] = await instance.app.sources.list();
    failing = true;

    const own = await (await instance.get(`/admin/sources/${source!.id}`, { cookie })).text();
    expect(own).toContain("The plugin could not offer anything to choose from.");
    expect(own).toContain("The account is signed out.");
  });
});
