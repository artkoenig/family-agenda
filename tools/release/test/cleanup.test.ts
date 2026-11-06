import { describe, expect, it } from "vitest";
import { planCleanup, versionsFromApi, type Children, type CleanupRules, type PackageVersion } from "../src/cleanup";

const now = new Date("2026-11-20T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
const rules: CleanupRules = { keepShaImages: 2, minimumAgeDays: 1, maximumDeletions: 100 };

let counter = 0;
const version = (digest: string, tags: string[], age: number): PackageVersion => ({ id: ++counter, digest, createdAt: daysAgo(age), tags });
const idsOf = (versions: PackageVersion[]) => versions.map((v) => v.digest).sort();

describe("what to clean out of the image package", () => {
  it("keeps every image with a tag of main, latest or a version, and the sha images beyond the newest few go", () => {
    const versions = [
      version("main", ["main", "sha-aaaaaaa"], 1),
      version("release", ["0.3.1", "0.3", "latest"], 10),
      version("old-release", ["0.2.0", "0.2"], 40),
      version("sha-new", ["sha-bbbbbbb"], 2),
      version("sha-newer", ["sha-ccccccc"], 1),
      version("sha-old", ["sha-ddddddd"], 20),
      version("sha-older", ["sha-eeeeeee"], 30),
    ];
    const children = Object.fromEntries(versions.map((v) => [v.digest, []]));

    const plan = planCleanup(versions, children, now, rules);

    expect(idsOf(plan.delete)).toEqual(["sha-old", "sha-older"]);
  });

  it("keeps an image that carries a sha tag next to another tag, and one with a tag nobody knows", () => {
    const versions = [version("a", ["sha-1234567", "0.3.1"], 90), version("b", ["sha-7654321", "experiment"], 90)];

    expect(planCleanup(versions, { a: [], b: [] }, now, { ...rules, keepShaImages: 0 }).delete).toEqual([]);
  });

  it("keeps the untagged versions that a staying image refers to, through the platform images to their attestations", () => {
    const versions = [
      version("list", ["0.3.1"], 5),
      version("amd64-index", [], 5),
      version("amd64-image", [], 5),
      version("amd64-attestation", [], 5),
      version("arm64-index", [], 5),
      version("stray", [], 5),
    ];
    const children: Children = {
      list: ["amd64-index", "arm64-index"],
      "amd64-index": ["amd64-image", "amd64-attestation"],
      "arm64-index": [],
      "amd64-image": [],
      "amd64-attestation": [],
      stray: [],
    };

    const plan = planCleanup(versions, children, now, rules);

    expect(idsOf(plan.delete)).toEqual(["stray"]);
    expect(plan.keptUntagged).toBe(4);
  });

  it("leaves an untagged version alone that is not a day old yet, and removes one that is", () => {
    const versions = [version("fresh", [], 0.5), version("settled", [], 1), version("release", ["0.3.1"], 3)];

    const plan = planCleanup(versions, { fresh: [], settled: [], release: [] }, now, rules);

    expect(idsOf(plan.delete)).toEqual(["settled"]);
  });

  it("lets go of the children of a sha image that goes, in the same run", () => {
    const versions = [version("sha-gone", ["sha-1111111"], 30), version("child", [], 30)];
    const children: Children = { "sha-gone": ["child"], child: [] };

    expect(idsOf(planCleanup(versions, children, now, { ...rules, keepShaImages: 0 }).delete)).toEqual(["child", "sha-gone"]);
  });

  it("keeps the children of a sha image that stays", () => {
    const versions = [version("sha-kept", ["sha-2222222"], 3), version("child", [], 3)];

    expect(planCleanup(versions, { "sha-kept": ["child"], child: [] }, now, rules).delete).toEqual([]);
  });

  it("deletes nothing when the manifest of an image that stays cannot be read, or is not known", () => {
    const versions = [version("release", ["0.3.1"], 3), version("orphan", [], 30)];

    expect(() => planCleanup(versions, { release: null, orphan: [] }, now, rules)).toThrow(/could not be read; nothing is deleted/);
    expect(() => planCleanup(versions, { orphan: [] }, now, rules)).toThrow(/could not be read; nothing is deleted/);
  });

  it("does not need the manifest of an untagged version that nothing refers to", () => {
    const versions = [version("release", ["0.3.1"], 3), version("orphan", [], 30)];

    expect(idsOf(planCleanup(versions, { release: [], orphan: null }, now, rules).delete)).toEqual(["orphan"]);
  });

  it("refuses a plan that deletes more than a run may", () => {
    const versions = [version("release", ["0.3.1"], 3), ...Array.from({ length: 4 }, (_, index) => version(`orphan-${index}`, [], 30))];
    const children = Object.fromEntries(versions.map((v) => [v.digest, []]));

    expect(() => planCleanup(versions, children, now, { ...rules, maximumDeletions: 3 })).toThrow(/deletes 4 versions, more than the 3/);
  });

  it("stays quiet about a package with nothing to remove", () => {
    expect(planCleanup([], {}, now, rules)).toEqual({ delete: [], keptTagged: 0, keptUntagged: 0 });
  });
});

describe("the versions of the package as the GitHub API lists them", () => {
  it("takes the digest from the name and the tags from the container metadata, none where there are none", () => {
    const listing = [
      { id: 7, name: "sha256:aaa", created_at: "2026-11-01T10:00:00Z", metadata: { package_type: "container", container: { tags: ["0.3.1", "latest"] } } },
      { id: 8, name: "sha256:bbb", created_at: "2026-11-02T10:00:00Z", metadata: { container: { tags: [] } } },
      { id: 9, name: "sha256:ccc", created_at: "2026-11-03T10:00:00Z" },
    ];

    expect(versionsFromApi(listing)).toEqual([
      { id: 7, digest: "sha256:aaa", createdAt: new Date("2026-11-01T10:00:00Z"), tags: ["0.3.1", "latest"] },
      { id: 8, digest: "sha256:bbb", createdAt: new Date("2026-11-02T10:00:00Z"), tags: [] },
      { id: 9, digest: "sha256:ccc", createdAt: new Date("2026-11-03T10:00:00Z"), tags: [] },
    ]);
  });
});
