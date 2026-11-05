import type { AgendaId, FamilyMemberId } from "@family-agenda/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootHttpForTest, type HttpTestInstance } from "../support/http";

describe("an Agenda as an app on the home screen", () => {
  let instance: HttpTestInstance;
  let mia: FamilyMemberId;
  let leo: FamilyMemberId;
  beforeEach(async () => {
    instance = await bootHttpForTest();
    await instance.post("/setup", { email: "anna@example.org", password: "correct horse battery" });
    await instance.app.recoveryKit.confirm();
    mia = await addMember("Mia");
    leo = await addMember("Leo");
  });
  afterEach(async () => {
    await instance.close();
  });

  const addMember = async (name: string) => {
    const added = await instance.app.familyMembers.add({ name });
    if (!added.ok) throw new Error("adding failed");
    return added.id;
  };

  const createAgenda = async (memberIds: FamilyMemberId[], layout?: "task_list"): Promise<AgendaId> => {
    const created = await instance.app.agendas.create({ memberIds, horizonDays: 2, ...(layout ? { layout } : {}) });
    if (!created.ok) throw new Error("creating failed");
    return created.id;
  };

  it("serves a manifest that opens the Agenda fullscreen, named after whom it is for", async () => {
    const agenda = await createAgenda([mia, leo]);

    const response = await instance.get(`/agendas/${agenda}/manifest.webmanifest`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8");
    expect(await response.json()).toMatchObject({
      id: `/agendas/${agenda}`,
      name: "Agenda",
      short_name: "Agenda",
      start_url: `/agendas/${agenda}`,
      scope: `/agendas/${agenda}`,
      display: "standalone",
            icons: [
        { src: "/static/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/static/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
  });

  it("names a Task List Todos and a timeline Agenda", async () => {
    const tasks = await createAgenda([mia], "task_list");

    const manifest = (await (await instance.get(`/agendas/${tasks}/manifest.webmanifest`)).json()) as { name: string };

    expect(manifest.name).toBe("Todos");
  });

  it("derives its addresses from the path it was opened at", async () => {
    const agenda = await createAgenda([mia]);

    const manifest = (await (
      await instance.get(`/agendas/${agenda}/manifest.webmanifest?show=${mia}&from=2026-01-01`)
    ).json()) as { start_url: string };

    expect(manifest.start_url).toBe(`/agendas/${agenda}`);
  });

  it("has no manifest for an Agenda that does not exist", async () => {
    const response = await instance.get("/agendas/00000000-0000-4000-8000-000000000000/manifest.webmanifest");

    expect(response.status).toBe(404);
  });

  it("links the manifest and the iOS tags from a timeline and from a Task List, and from nothing else", async () => {
    const timeline = await createAgenda([mia]);
    const tasks = await createAgenda([mia], "task_list");

    for (const agenda of [timeline, tasks]) {
      const page = await (await instance.get(`/agendas/${agenda}`)).text();
      expect(page).toContain(`<link rel="manifest" href="/agendas/${agenda}/manifest.webmanifest"`);
      expect(page).toContain('<meta name="apple-mobile-web-app-capable" content="yes"');
      expect(page).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"');
      expect(page).toContain('<link rel="apple-touch-icon" href="/static/icons/apple-touch-icon.png"');
      expect(page).toContain('<meta name="theme-color"');
      expect(page).toContain("viewport-fit=cover");
    }
    const setup = await (await instance.get("/admin/sign-in")).text();
    expect(setup).not.toContain('rel="manifest"');
    expect(setup).not.toContain("viewport-fit=cover");
  });

  it("serves the placeholder icons, and no other", async () => {
    for (const [file, bytes] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]] as const) {
      const response = await instance.get(`/static/icons/${file}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      const png = new Uint8Array(await response.arrayBuffer());
      // IHDR: width and height as 32-bit big-endian numbers after the 8-byte signature and chunk header.
      const view = new DataView(png.buffer);
      expect([view.getUint32(16), view.getUint32(20)]).toEqual([bytes, bytes]);
    }
    expect((await instance.get("/static/icons/unknown.png")).status).toBe(404);
  });
});
