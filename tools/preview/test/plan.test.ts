import { describe, expect, it } from "vitest";
import { describePreviews, planPreview } from "../src/plan";

const repo = "/work/family-agenda";

describe("planning a preview of a pull request", () => {
  it("gives each pull request its own project, port, worktree and image, so two previews run side by side", () => {
    const a = planPreview(189, repo);
    const b = planPreview(190, repo);

    expect(a).toMatchObject({
      project: "fa-pr-189",
      port: 9189,
      url: "http://localhost:9189",
      worktree: "/work/family-agenda/.previews/pr-189",
      image: "family-agenda-preview:pr-189",
      demoImage: "family-agenda-demo-source-preview:pr-189",
    });
    expect(new Set([a.project, b.project]).size).toBe(2);
    expect(new Set([a.port, b.port]).size).toBe(2);
    expect(new Set([a.worktree, b.worktree]).size).toBe(2);
    expect(new Set([a.image, b.image]).size).toBe(2);
    expect(new Set([a.demoImage, b.demoImage]).size).toBe(2);
  });

  it("checks the pull request's code out, builds it and the demo Source, generates the plugin containers and waits until it is healthy before seeding", () => {
    const { up } = planPreview(189, repo, "501:20");

    expect(up.map(({ file, args }) => [file, ...args].slice(0, 4).join(" "))).toEqual([
      "git fetch origin +pull/189/head:refs/previews/pr-189",
      "git worktree add --force",
      "cp /work/family-agenda/tools/preview/plugins.yml /work/family-agenda/.previews/pr-189/plugins.yml",
      "docker compose -p fa-pr-189",
      "docker compose -p fa-pr-189",
      "docker compose -p fa-pr-189",
      "docker compose -p fa-pr-189",
    ]);
    const [, , , build, generate, start, seed] = up;
    expect(build?.args.slice(-3)).toEqual(["build", "api", "plugin-demo"]);
    expect(generate?.args.slice(-10)).toEqual(["run", "--rm", "--no-deps", "--user", "501:20", "-v", "/work/family-agenda/.previews/pr-189:/deployment", "api", "plugins", "generate"]);
    expect(start?.args).toContain("--wait");
    expect(start?.env).toMatchObject({ PORT: "9189", PUBLIC_URL: "http://localhost:9189" });
    expect(seed?.args).toEqual(expect.arrayContaining(["exec", "-T", "api", "node", "--import", "tsx"]));
  });

  it("starts the generated plugin containers, with the overlay last so that it names the preview's own images", () => {
    const worktree = "/work/family-agenda/.previews/pr-189";
    const overlay = ["-f", "/work/family-agenda/tools/preview/compose.preview.yaml"];
    const { up } = planPreview(189, repo);

    const [, , , build, generate, start, seed] = up;
    for (const beforeGenerating of [build, generate]) {
      expect(beforeGenerating?.args).toEqual(expect.arrayContaining(["-f", `${worktree}/compose.yaml`, ...overlay]));
      expect(beforeGenerating?.args).not.toContain(`${worktree}/compose.plugins.yaml`);
    }
    for (const afterGenerating of [start, seed]) {
      expect(afterGenerating?.args).toEqual(expect.arrayContaining(["-f", `${worktree}/compose.yaml`, "-f", `${worktree}/compose.plugins.yaml`, ...overlay]));
    }
  });

  it("keeps the preview off the real Instance: its own port and images, also for the egress proxies", () => {
    const { up } = planPreview(189, repo);

    expect(up[5]?.env).toMatchObject({
      PREVIEW_ROOT: repo,
      PREVIEW_TOOLS: "/work/family-agenda/tools",
      PREVIEW_IMAGE: "family-agenda-preview:pr-189",
      PREVIEW_DEMO_IMAGE: "family-agenda-demo-source-preview:pr-189",
      EGRESS_PROXY_IMAGE: "family-agenda-preview:pr-189",
    });
  });

  it("removes everything the preview made when it comes down", () => {
    const { down } = planPreview(189, repo);

    expect(down.map(({ file, args }) => [file, ...args].join(" "))).toEqual([
      "docker compose -p fa-pr-189 down --volumes --remove-orphans",
      "docker rmi --force family-agenda-preview:pr-189 family-agenda-demo-source-preview:pr-189",
      "git worktree remove --force /work/family-agenda/.previews/pr-189",
      "git update-ref -d refs/previews/pr-189",
    ]);
  });

  it.each([0, -1, 1.5, Number.NaN, 50_000])("refuses %s as a pull request number", (pr) => {
    expect(() => planPreview(pr, repo)).toThrow(/pull request number/);
  });
});

describe("listing the previews", () => {
  it("names the pull request, address and state of each running project, and ignores other projects", () => {
    const composeLs = JSON.stringify([
      { Name: "fa-pr-190", Status: "running(3)" },
      { Name: "family-agenda", Status: "running(4)" },
      { Name: "fa-pr-189", Status: "exited(1)" },
    ]);

    expect(describePreviews(composeLs)).toEqual(["PR 189  http://localhost:9189  exited(1)", "PR 190  http://localhost:9190  running(3)"]);
  });
});
