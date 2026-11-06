import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSnapshot } from "../src/snapshot";

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
    commit(repo, { "compose.yaml": "image: postgres:18\n", "packages/adapters/drizzle/0001_more.sql": "CREATE TABLE b (id int);" }, "second");
    return repo;
  };

  it("reads the migrations and the compose file as they were at a tag", () => {
    const repo = repoWithTwoReleases();

    expect(readSnapshot(repo, "v0.1.0")).toEqual({
      migrations: { "0000_initial.sql": "CREATE TABLE a (id int);" },
      compose: "image: postgres:17\n",
    });
  });

  it("reads the state of HEAD, leaving out files that are no migrations", () => {
    const repo = repoWithTwoReleases();

    const { migrations, compose } = readSnapshot(repo, "HEAD");

    expect(Object.keys(migrations)).toEqual(["0000_initial.sql", "0001_more.sql"]);
    expect(compose).toBe("image: postgres:18\n");
  });

  it("fails for a ref that does not exist, instead of reading nothing", () => {
    const repo = repoWithTwoReleases();

    expect(() => readSnapshot(repo, "v9.9.9")).toThrow();
  });
});
