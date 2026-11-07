import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPackageApis, readSnapshot } from "../src/snapshot";

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { encoding: "utf8" });

function commit(repo: string, files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

describe("reading the snapshot of a release from Git", () => {
  const repoWithTwoReleases = () => {
    const repo = mkdtempSync(join(tmpdir(), "release-snapshot-"));
    repos.push(repo);
    git(repo, "init", "-q");
    commit(repo, { "compose.yaml": "image: postgres:17\n", "packages/adapters/drizzle/0000_initial.sql": "CREATE TABLE a (id int);", "packages/adapters/drizzle/meta/_journal.json": "{}" }, "first");
    git(repo, "tag", "v0.1.0");
    commit(
      repo,
      {
        "compose.yaml": "image: postgres:18\n",
        "packages/adapters/drizzle/0001_more.sql": "CREATE TABLE b (id int);",
        "packages/source-sdk/package.json": JSON.stringify({ name: "sdk", version: "1.2.0" }),
        "packages/source-sdk/api.txt": "export type A = {};\n",
      },
      "second",
    );
    return repo;
  };

  it("reads the migrations and the compose file as they were at a tag", () => {
    const repo = repoWithTwoReleases();

    expect(readSnapshot(repo, "v0.1.0")).toEqual({
      migrations: { "0000_initial.sql": "CREATE TABLE a (id int);" },
      compose: "image: postgres:17\n",
      sdk: null,
    });
  });

  it("reads the state of HEAD, leaving out files that are no migrations", () => {
    const repo = repoWithTwoReleases();

    const { migrations, compose } = readSnapshot(repo, "HEAD");

    expect(Object.keys(migrations)).toEqual(["0000_initial.sql", "0001_more.sql"]);
    expect(compose).toBe("image: postgres:18\n");
  });

  it("reads the SDK's version and API file where the ref has them, and none where it has not", () => {
    const repo = repoWithTwoReleases();

    expect(readSnapshot(repo, "HEAD").sdk).toEqual({ version: "1.2.0", api: "export type A = {};\n" });
    expect(readSnapshot(repo, "v0.1.0").sdk).toBeNull();
  });

  it("reads the version and API file of every package that has one", () => {
    const repo = repoWithTwoReleases();
    commit(repo, { "packages/domain/package.json": JSON.stringify({ version: "0.3.0" }), "packages/domain/api.txt": "export {};\n", "packages/contracts/package.json": "{}" }, "third");

    expect(readPackageApis(repo, "HEAD")).toEqual({
      "source-sdk": { version: "1.2.0", api: "export type A = {};\n" },
      domain: { version: "0.3.0", api: "export {};\n" },
    });
    expect(readPackageApis(repo, "v0.1.0")).toEqual({});
  });

  it("fails for a ref that does not exist, instead of reading nothing", () => {
    const repo = repoWithTwoReleases();

    expect(() => readSnapshot(repo, "v9.9.9")).toThrow();
  });
});
