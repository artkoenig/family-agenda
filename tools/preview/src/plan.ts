import { join } from "node:path";

/** A program to run, as `pnpm preview` runs it: no shell, so nothing here is ever interpreted. */
export type Command = { file: string; args: string[]; env?: Record<string, string> };

export type PreviewPlan = {
  project: string;
  port: number;
  url: string;
  worktree: string;
  /** The image the preview's code is built into; not `family-agenda:local`, which is the real Instance's. */
  image: string;
  up: Command[];
  down: Command[];
};

/** Previews listen on 9000 plus the pull request number, so a number alone settles the port. */
const firstPort = 9000;
const largestPullRequest = 49_999;
const previewPrefix = "fa-pr-";
const previewMasterKey = Buffer.alloc(32, 7).toString("base64");

/**
 * What it takes to run a pull request's code as an Instance of its own, and to remove it again:
 * its own Compose project, port, worktree and image, so that previews of several pull requests
 * run side by side and beside the real Instance. `repoRoot` is the clone `pnpm preview` runs in,
 * where the demo Source and the Compose override live: a pull request may predate them.
 */
export function planPreview(pullRequest: number, repoRoot: string): PreviewPlan {
  if (!Number.isInteger(pullRequest) || pullRequest < 1 || pullRequest > largestPullRequest) {
    throw new Error(`"${pullRequest}" is no pull request number`);
  }
  const project = `${previewPrefix}${pullRequest}`;
  const port = firstPort + pullRequest;
  const url = `http://localhost:${port}`;
  const worktree = join(repoRoot, ".previews", `pr-${pullRequest}`);
  const image = `family-agenda-preview:pr-${pullRequest}`;
  const ref = `refs/previews/pr-${pullRequest}`;

  // A preview holds no real data, so its master key is the same throwaway one everywhere.
  const env = { PORT: String(port), PUBLIC_URL: url, MASTER_KEY: previewMasterKey, PREVIEW_TOOLS: join(repoRoot, "tools"), PREVIEW_IMAGE: image };
  const compose = (...args: string[]): Command => ({
    file: "docker",
    args: ["compose", "-p", project, "--project-directory", worktree, "-f", join(worktree, "compose.yaml"), "-f", join(repoRoot, "tools", "preview", "compose.preview.yaml"), ...args],
    env,
  });

  return {
    project,
    port,
    url,
    worktree,
    image,
    up: [
      { file: "git", args: ["fetch", "origin", `+pull/${pullRequest}/head:${ref}`] },
      { file: "git", args: ["worktree", "add", "--force", "--detach", worktree, ref] },
      compose("up", "--detach", "--build", "--wait"),
      compose("exec", "-T", "api", "node", "--import", "tsx", "/preview-tools/preview/src/seed-main.ts"),
    ],
    down: [
      { file: "docker", args: ["compose", "-p", project, "down", "--volumes", "--remove-orphans"] },
      { file: "docker", args: ["rmi", "--force", image] },
      { file: "git", args: ["worktree", "remove", "--force", worktree] },
      { file: "git", args: ["update-ref", "-d", ref] },
    ],
  };
}

/** The previews in the output of `docker compose ls --format json`, one line each, by pull request. */
export function describePreviews(composeLs: string): string[] {
  const projects = JSON.parse(composeLs) as { Name: string; Status: string }[];
  return projects
    .flatMap(({ Name, Status }) => {
      const pullRequest = new RegExp(`^${previewPrefix}(\\d+)$`).exec(Name)?.[1];
      return pullRequest === undefined ? [] : [{ pullRequest: Number(pullRequest), Status }];
    })
    .sort((a, b) => a.pullRequest - b.pullRequest)
    .map(({ pullRequest, Status }) => `PR ${pullRequest}  http://localhost:${firstPort + pullRequest}  ${Status}`);
}
