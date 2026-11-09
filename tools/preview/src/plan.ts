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
  /** The image the demo Source's plugin container is built into, from the clone `pnpm preview` runs in. */
  demoImage: string;
  up: Command[];
  down: Command[];
};

/** Previews listen on 9000 plus the pull request number, so a number alone settles the port. */
const firstPort = 9000;
const largestPullRequest = 49_999;
const previewPrefix = "fa-pr-";

/**
 * What it takes to run a pull request's code as an Instance of its own, and to remove it again:
 * its own Compose project, port, worktree and image, so that previews of several pull requests
 * run side by side and beside the real Instance. `repoRoot` is the clone `pnpm preview` runs in,
 * where the demo Source, its plugins.yml and the Compose override live: a pull request may predate them.
 * The plugin containers come from the pull request's own generator (`plugins generate`), run in
 * its image as `user` (uid:gid), so that it writes into the worktree as the developer.
 */
export function planPreview(pullRequest: number, repoRoot: string, user: string): PreviewPlan {
  if (!Number.isInteger(pullRequest) || pullRequest < 1 || pullRequest > largestPullRequest) {
    throw new Error(`"${pullRequest}" is no pull request number`);
  }
  const project = `${previewPrefix}${pullRequest}`;
  const port = firstPort + pullRequest;
  const url = `http://localhost:${port}`;
  const worktree = join(repoRoot, ".previews", `pr-${pullRequest}`);
  const image = `family-agenda-preview:pr-${pullRequest}`;
  const demoImage = `family-agenda-demo-source-preview:pr-${pullRequest}`;
  const ref = `refs/previews/pr-${pullRequest}`;

  const env = {
    PORT: String(port),
    PUBLIC_URL: url,
    PREVIEW_ROOT: repoRoot,
    PREVIEW_TOOLS: join(repoRoot, "tools"),
    PREVIEW_IMAGE: image,
    PREVIEW_DEMO_IMAGE: demoImage,
    EGRESS_PROXY_IMAGE: image,
  };
  const overlay = join(repoRoot, "tools", "preview", "compose.preview.yaml");
  const composeWith = (files: string[], args: string[]): Command => ({
    file: "docker",
    args: ["compose", "-p", project, "--project-directory", worktree, ...files.flatMap((file) => ["-f", file]), ...args],
    env,
  });
  /** Compose over the pull request's compose.yaml and the overlay, before the plugins file is generated. */
  const composeBase = (...args: string[]) => composeWith([join(worktree, "compose.yaml"), overlay], args);
  /** Compose with the generated plugins file too, the overlay last so that it names the preview's images. */
  const composeWithPlugins = (...args: string[]) =>
    composeWith([join(worktree, "compose.yaml"), join(worktree, "compose.plugins.yaml"), overlay], args);

  return {
    project,
    port,
    url,
    worktree,
    image,
    demoImage,
    up: [
      { file: "git", args: ["fetch", "origin", `+pull/${pullRequest}/head:${ref}`] },
      { file: "git", args: ["worktree", "add", "--force", "--detach", worktree, ref] },
      { file: "cp", args: [join(repoRoot, "tools", "preview", "plugins.yml"), join(worktree, "plugins.yml")] },
      composeBase("build", "api", "plugin-demo"),
      composeBase("run", "--rm", "--no-deps", "--user", user, "-v", `${worktree}:/deployment`, "api", "plugins", "generate"),
      composeWithPlugins("up", "--detach", "--wait"),
      composeWithPlugins("exec", "-T", "api", "node", "--import", "tsx", "/preview-tools/preview/src/seed-main.ts"),
    ],
    down: [
      { file: "docker", args: ["compose", "-p", project, "down", "--volumes", "--remove-orphans"] },
      { file: "docker", args: ["rmi", "--force", image, demoImage] },
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
