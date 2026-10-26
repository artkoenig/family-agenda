import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { photos } from "../support/photos";
import { bootForTest, type TestInstance } from "../support/boot";

describe("managing Family Members", () => {
  let instance: TestInstance;
  beforeEach(async () => {
    instance = await bootForTest();
  });
  afterEach(async () => {
    await instance.close();
  });

  it("adds Family Members by name, who fall back to their initial without a photo", async () => {
    expect(await instance.app.familyMembers.add({ name: "  Mia " })).toMatchObject({ ok: true });
    await instance.app.familyMembers.add({ name: "leo" });

    const members = await instance.app.familyMembers.list();
    expect(members.map((member) => [member.name, member.initial, member.hasPhoto])).toEqual([
      ["Mia", "M", false],
      ["leo", "L", false],
    ]);
  });

  it("refuses a Family Member without a name", async () => {
    expect(await instance.app.familyMembers.add({ name: "   " })).toEqual({
      ok: false,
      problem: "invalid-name",
    });
    expect(await instance.app.familyMembers.list()).toEqual([]);
  });

  it("renames and removes Family Members", async () => {
    const mia = await addMember("Mia");
    const leo = await addMember("Leo");

    expect(await instance.app.familyMembers.edit(mia, { name: "Mia Sophie" })).toEqual({ ok: true });
    expect(await instance.app.familyMembers.edit(mia, { name: "" })).toEqual({
      ok: false,
      problem: "invalid-name",
    });
    await instance.app.familyMembers.remove(leo);

    expect((await instance.app.familyMembers.list()).map((member) => member.name)).toEqual([
      "Mia Sophie",
    ]);
    expect(await instance.app.familyMembers.edit(leo, { name: "Leo" })).toEqual({
      ok: false,
      problem: "unknown-member",
    });
  });

  it("keeps an optional photo, which can be replaced and removed", async () => {
    const added = await instance.app.familyMembers.add({ name: "Mia", photo: photos.png });
    if (!added.ok) throw new Error("adding failed");
    expect((await instance.app.familyMembers.list())[0]?.hasPhoto).toBe(true);
    expect(await instance.app.familyMembers.photo(added.id)).toEqual({
      bytes: photos.png,
      contentType: "image/png",
    });

    await instance.app.familyMembers.edit(added.id, { name: "Mia", photo: photos.jpeg });
    expect((await instance.app.familyMembers.photo(added.id))?.contentType).toBe("image/jpeg");

    await instance.app.familyMembers.edit(added.id, { name: "Mia", photo: null });
    expect((await instance.app.familyMembers.list())[0]?.hasPhoto).toBe(false);
    expect(await instance.app.familyMembers.photo(added.id)).toBeNull();
  });

  it("keeps the photo when only the name changes, and drops it with the Family Member", async () => {
    const mia = await addMember("Mia", photos.webp);

    await instance.app.familyMembers.edit(mia, { name: "Mia Sophie" });
    expect((await instance.app.familyMembers.photo(mia))?.contentType).toBe("image/webp");

    await instance.app.familyMembers.remove(mia);
    expect(await instance.app.familyMembers.photo(mia)).toBeNull();
  });

  it("refuses a photo that is no JPEG, PNG, WebP or GIF image, or is too large", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(await instance.app.familyMembers.add({ name: "Mia", photo: svg })).toEqual({
      ok: false,
      problem: "invalid-photo",
    });

    const huge = new Uint8Array(6 * 1024 * 1024);
    huge.set(photos.png);
    expect(await instance.app.familyMembers.add({ name: "Mia", photo: huge })).toEqual({
      ok: false,
      problem: "photo-too-large",
    });

    const mia = await addMember("Mia", photos.png);
    expect(await instance.app.familyMembers.edit(mia, { name: "Mia", photo: svg })).toEqual({
      ok: false,
      problem: "invalid-photo",
    });
    expect((await instance.app.familyMembers.photo(mia))?.contentType).toBe("image/png");
  });

  const addMember = async (name: string, photo?: Uint8Array) => {
    const added = await instance.app.familyMembers.add({ name, ...(photo ? { photo } : {}) });
    if (!added.ok) throw new Error("adding failed");
    return added.id;
  };
});
