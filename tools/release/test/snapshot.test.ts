import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readContract, readSnapshot } from "../src/snapshot";

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
        "packages/plugin-contract/openapi.json": '{"info":{"version":"1.0"}}\n',
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
      inProcessPlugins: false,
    });
  });

  it("reads the state of HEAD, leaving out files that are no migrations", () => {
    const repo = repoWithTwoReleases();

    const { migrations, compose } = readSnapshot(repo, "HEAD");

    expect(Object.keys(migrations)).toEqual(["0000_initial.sql", "0001_more.sql"]);
    expect(compose).toBe("image: postgres:18\n");
  });

  it("reads whether a ref ran Source plugins in-process, by its SDK package", () => {
    const repo = repoWithTwoReleases();

    expect(readSnapshot(repo, "HEAD").inProcessPlugins).toBe(true);
    expect(readSnapshot(repo, "v0.1.0").inProcessPlugins).toBe(false);
  });

  it("reads the plugin contract's openapi.json where the ref has it, and none where it has not", () => {
    const repo = repoWithTwoReleases();

    expect(readContract(repo, "HEAD")).toBe('{"info":{"version":"1.0"}}\n');
    expect(readContract(repo, "v0.1.0")).toBeNull();
  });

  it("fails for a ref that does not exist, instead of reading nothing", () => {
    const repo = repoWithTwoReleases();

    expect(() => readSnapshot(repo, "v9.9.9")).toThrow();
  });
});
