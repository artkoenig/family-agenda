# Building the image for linux/arm64 on GitHub Actions

Question (issue #193, part of map #192): can the current `Dockerfile` produce a working `linux/arm64` image next to `linux/amd64`, how, and at what cost?

Research date: 2026-11-06. Method: GitHub and Docker documentation were read from their source repositories (`github/docs`, `docker/docs`, on `raw.githubusercontent.com`) because `docs.github.com` and `docs.docker.com` could not be fetched from the research sandbox. Package metadata was read directly from the PyPI, npm, Go module proxy and Docker Hub APIs. **Nothing was built**: the sandbox is x86_64 and has no usable Docker daemon, so build times, image sizes and runtime behaviour on arm64 are **unmeasured** and listed under "Open items". Debian package availability for arm64 could not be fetched either (`packages.debian.org` and `deb.debian.org` are blocked) and is *unverified*.

## Summary

- **Every build step has an arm64 path** on paper: both base images publish arm64, Synapse and psycopg2-binary publish `aarch64` wheels, the npm native modules ship `linux-arm64-gnu` bindings, and the Go bridge compiles natively on an arm64 host. No step needs a source build of a heavy dependency. The Dockerfile needs **no change to build**, only optional hardening.
- **Best option: per-platform native builds, then a manifest merge**, on `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm` (arm64). QEMU in one job works but Docker itself says it "can be much slower"; the Go stage is the expensive one under emulation.
- **Private repo (today)**: `ubuntu-24.04-arm` is available to private repositories as a standard 2-core runner, billed at **$0.005/min** against the plan's included compute usage (Free: $12/month, Pro/Team: $18/month). An arm64 job costs less per minute than the x64 equivalent ($0.006/min).
- **Public repo**: standard runners are free and unlimited, and the public arm64 runner is a 4-core / 16 GB machine rather than 2-core / 8 GB.
- **GHCR**: a newly published package is **private by default, regardless of repository visibility**. Families pulling anonymously need the *package* set to public (one-way: it cannot be made private again). Container registry storage and bandwidth are currently free.

## 1. Does each Dockerfile step work on arm64?

| Dockerfile step | arm64 status | Evidence |
|---|---|---|
| `FROM golang:1.27-bookworm` | Published for amd64 and arm64/v8 | Docker Hub tag `library/golang:1.27-bookworm` lists both (300.6 MB amd64, 290.8 MB arm64 compressed) [Docker Hub API](https://hub.docker.com/v2/repositories/library/golang/tags/1.27-bookworm) |
| `FROM node:24-bookworm-slim` | Published for amd64 and arm64/v8 | Tag lists both (81.0 MB amd64, 80.9 MB arm64 compressed) [Docker Hub API](https://hub.docker.com/v2/repositories/library/node/tags/24-bookworm-slim) |
| `go install -tags goolm ... mautrix-whatsapp@v0.2609.0` with `CGO_ENABLED=1` | Builds natively on an arm64 host: the golang image carries gcc, and `goolm` is pure Go so there is no libolm to find. The only cgo dependency in the module graph is `github.com/mattn/go-sqlite3` (listed as indirect), which is plain C compiled by the host gcc. Not built here, *unverified in practice* | [go.mod via Go proxy](https://proxy.golang.org/go.mau.fi/mautrix-whatsapp/@v/v0.2609.0.mod); tag exists [info](https://proxy.golang.org/go.mau.fi/mautrix-whatsapp/@v/v0.2609.0.info) |
| apt: `poppler-utils tesseract-ocr tesseract-ocr-{deu,eng,osd} python3 python3-venv` | Expected to work: Debian bookworm is a release architecture for arm64 and these are standard packages. *Unverified*, the Debian package pages could not be fetched | (blocked hosts) |
| `pip install matrix-synapse==1.163.2` | Wheel `cp310-abi3-manylinux_2_28_aarch64` (8.8 MB). abi3 means it installs on bookworm's Python 3.11; bookworm's glibc 2.36 satisfies manylinux_2_28 | [PyPI JSON](https://pypi.org/pypi/matrix-synapse/1.163.2/json) |
| `pip install psycopg2-binary==2.9.13` | Wheel `cp311-cp311-manylinux_2_27_aarch64.manylinux_2_28_aarch64` (5.9 MB) | [PyPI JSON](https://pypi.org/pypi/psycopg2-binary/2.9.13/json) |
| `pnpm install --frozen-lockfile --prod`, `@node-rs/argon2` | Ships `@node-rs/argon2-linux-arm64-gnu` as an optional dependency; the lockfile pins it and `pnpm-workspace.yaml` already allows its build script | [npm registry](https://registry.npmjs.org/@node-rs/argon2/2.2.2); `pnpm-workspace.yaml` |
| `tsx` (runtime, via `esbuild`) | `esbuild` has `@esbuild/linux-arm64` as an optional dependency | [npm registry](https://registry.npmjs.org/esbuild/0.28.2) |

Other runtime dependencies in the workspace (`hono`, `pg`, `pg-boss`, `drizzle-orm`, `imapflow`, `mailparser`, `ical.js`, `zod`, `openid-client`, `qrcode`) are pure JavaScript. (`package.json` files in the repo.) `@electric-sql/pglite` appears only in the dev/test graph, not in `--prod`.

Consequence for the image: the single-line `pip install` of a Rust-extension package (Synapse) is the step that would be most painful if a wheel were missing (it would compile Rust under emulation or natively). Because the aarch64 wheel exists for the pinned version, that does not happen. **Re-check the wheel list whenever the `matrix-synapse` pin is bumped.**

## 2. GitHub Actions options and availability

### Runner availability and price

From the GitHub docs source:

| | Private repository | Public repository |
|---|---|---|
| `ubuntu-24.04-arm` available | Yes, as a standard runner | Yes |
| Size | 2 vCPU, 8 GB RAM, 14 GB SSD | 4 vCPU, 16 GB RAM, 14 GB SSD |
| Cost | Draws from included compute usage, then **$0.005/min** (`actions_linux_arm`) | Free and unlimited |
| x64 comparison | `ubuntu-24.04`: 2-core, **$0.006/min** | `ubuntu-24.04`: 4-core, free |

Sources: standard runner tables, [public](https://github.com/github/docs/blob/main/data/reusables/actions/supported-github-runners.md) and private sections of the same file; per-minute rates in [Actions runner pricing](https://github.com/github/docs/blob/main/data/reusables/billing/actions-standard-runner-prices.md) (rendered at docs.github.com/en/billing/reference/actions-runner-pricing); "The use of standard GitHub-hosted runners is free in public repositories" in [Actions billing](https://github.com/github/docs/blob/main/content/billing/concepts/product-billing/github-actions.md).

Included monthly compute usage (private repositories) [source](https://github.com/github/docs/blob/main/data/reusables/billing/actions-included-quotas.md): Free $12, Pro $18, Team $18, Enterprise Cloud $300. Usage is rounded up to whole minutes per job and charged to the repository owner. At $0.005/min, $12 covers 2,400 arm64 minutes (2,000 x64 minutes at $0.006), a ratio the docs themselves use ("$300 USD covers 50,000 minutes on a standard Linux runner at $0.006 USD per minute").

The *larger* arm runners (`linux_4_core_arm` etc., $0.008/min and up) are a separate paid product that is **not free for public repositories**. They are not needed here. The standard `ubuntu-24.04-arm` label is the one the Docker docs' default runner mapping uses.

### Strategy A: QEMU emulation in one job

`docker/setup-qemu-action` plus `docker/build-push-action` with `platforms: linux/amd64,linux/arm64` on a single `ubuntu-24.04` runner ([Docker: multi-platform with GitHub Actions](https://github.com/docker/docs/blob/main/content/manuals/build/ci/github-actions/multi-platform.md)).
- Simplest workflow, one job, one manifest.
- Docker's guidance: emulation "can be much slower than native builds, especially for compute-heavy tasks such as compilation and compression" and to prefer native nodes or cross-compilation ([Docker: multi-platform builds](https://github.com/docker/docs/blob/main/content/manuals/build/building/multi-platform.md)). In this Dockerfile the heavy emulated work would be the Go compile (`go install` of a large dependency graph with cgo), apt, and `pnpm install`. The Go stage is the one to fear. Slowdown factor is **unmeasured here**.
- Emulated minutes are x64 minutes at $0.006 on a private repo, so a slow arm64 leg directly increases billed time.

### Strategy B: native runners, per-platform build, manifest merge (recommended)

Run one job per platform, `ubuntu-24.04` and `ubuntu-24.04-arm`, each pushing by digest, then a final job creates the multi-arch tag (`docker buildx imagetools create`). Docker documents this shape and ships a reusable implementation: the [Docker GitHub Builder](https://github.com/docker/docs/blob/main/content/manuals/build/ci/github-actions/multi-platform.md#distribute-build-across-multiple-runners) `build.yml` workflow computes the per-platform matrix, runs each platform on its own runner, and assembles the manifest; its default runner mapping sends Linux Arm to `ubuntu-24.04-arm` and everything else to `ubuntu-24.04`.
- No emulation: both legs run at native speed and run in parallel, so wall-clock time is about the slower leg.
- Cost: two native jobs, arm at $0.005/min and x64 at $0.006/min on a private repo; free on a public repo.
- Trade-off: more workflow YAML (matrix + merge job), or a dependency on a third-party reusable workflow pinned by SHA/version. Using the Docker reusable workflow is a decision for the implementation ticket; the core mechanics are two plain `build-push-action` legs plus `imagetools create`.

### Strategy C: cross-compilation of the Go stage only

Pin the Go stage to `--platform=$BUILDPLATFORM` and set `GOARCH=$TARGETARCH`. This avoids emulating the compile, but with `CGO_ENABLED=1` a cross C toolchain (for example `gcc-aarch64-linux-gnu`, `CC=aarch64-linux-gnu-gcc`) is required, and `go-sqlite3` is C. It adds Dockerfile complexity for a saving that Strategy B already delivers by running natively. Not recommended unless QEMU is chosen. ([Docker: cross-compilation](https://github.com/docker/docs/blob/main/content/manuals/build/building/multi-platform.md).)

### Layer caching

- `type=gha` is Docker's recommended cache backend inside GitHub Actions "as long as your use case falls within the size and usage limits set by GitHub" ([Docker: GitHub Actions cache](https://github.com/docker/docs/blob/main/content/manuals/build/cache/backends/gha.md)). Use `mode=max` to export intermediate layers (the Go stage is an intermediate stage, so `min` would not cache it) and a distinct `scope` per platform so the legs do not overwrite each other.
- GitHub's limits: entries not accessed for 7 days are evicted, and the default total is **10 GB per repository**; beyond 10 GB is billed if raised ([Dependency caching reference](https://github.com/github/docs/blob/main/content/actions/reference/workflows-and-actions/dependency-caching.md)). Cache storage is a separate allowance from package/artifact storage. A mode=max cache for two platforms of this image (Go toolchain layers, apt layer, pip layer, node_modules) could plausibly approach several GB; **unmeasured**. A registry cache (`type=registry,ref=ghcr.io/...:buildcache`) avoids the 10 GB and 7-day limits at the cost of GHCR storage (see section 3).
- Docker notes the gha backend can hit GitHub cache API rate limits on cache-heavy builds ([same page](https://github.com/docker/docs/blob/main/content/manuals/build/cache/backends/gha.md#avoid-github-actions-cache-api-throttling)).
- Layer order helps: in the Dockerfile the expensive, rarely-changing layers (Go build with a pinned version, apt, pip with pinned versions) come before `COPY . .`, so a source-only change reuses them from cache. Only `pnpm install` and later re-run.

### Image size per platform

Not measured. Indicators only: base images are within 0.2 % of each other across platforms (node-slim 81.0 vs 80.9 MB compressed; golang 300.6 vs 290.8 MB, which is a builder stage and not shipped). The shipped contents (Debian packages, wheels, JS, one Go binary) are similar in size on both architectures, so expect the two platform images to be within a few percent. Confirm with a real build.

## 3. GHCR visibility and billing, private vs public repository

- **Default visibility is private, independent of the repository.** "When you first publish a package, the default visibility is private and only you can see the package." A package linked to a repository inherits its *access permissions* but **not its visibility** ([Configuring a package's access control and visibility](https://github.com/github/docs/blob/main/content/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility.md)). So making the repository public does not by itself make the image pullable.
- **Anonymous pulls by Families require a public package.** A private package needs `docker login ghcr.io` with a token that has `read:packages`. For a self-hosted product aimed at families on Raspberry Pi/NAS hosts, a public package is the practical choice.
- **Making a package public is irreversible**: "Once you make a package public, you cannot make it private again." (same page). Decide this deliberately.
- **Linking** the package to the repository: pushing from the command line does not link it by default; GitHub recommends adding the `org.opencontainers.image.source` label (a `LABEL` in the Dockerfile or a build-time `--label`) so the package connects to the repository and a workflow `GITHUB_TOKEN` gets the right permissions ([Working with the Container registry](https://github.com/github/docs/blob/main/content/packages/working-with-a-github-packages-registry/working-with-the-container-registry.md)). The Dockerfile has no such label today.
- **Billing**: "GitHub Packages usage is free for public packages." For private packages, storage and transfer count against the plan's quota (Free 500 MB storage / 1 GB transfer per month, shared with Actions artifacts). However, docs state that "Container image storage and bandwidth for the GitHub Container registry is currently free", with at least one month's notice before any change ([GitHub Packages billing](https://github.com/github/docs/blob/main/content/billing/concepts/product-billing/github-packages.md)). That statement is the one to watch; it is a policy, not a contract.
- Pulls from Actions with `GITHUB_TOKEN` are free for private packages too (same page).

Matrix of the four combinations that matter:

| | Repo private | Repo public |
|---|---|---|
| arm64 runner | 2-core 8 GB, $0.005/min from included usage ($12 Free) | 4-core 16 GB, free |
| x64 runner | 2-core, $0.006/min | 4-core, free |
| Image package default | private | private (visibility is not inherited) |
| Anonymous Family pulls | only after package set public | only after package set public |
| Package storage/transfer cost | free for GHCR today (policy); otherwise private quota | free |

## 4. Dockerfile changes worth making for reliable multi-arch builds

None are required for the build to work. Recommended hardening, smallest first:

1. **Keep bridge and image platforms in step.** Do not hard-code `--platform` anywhere (none exists today); leave the Go stage on the target platform so each native leg compiles for its own architecture.
2. **Pin the Go toolchain tag consistently.** The bridge's `go.mod` says `toolchain go1.27.1`; `golang:1.27-bookworm` floats to the latest 1.27.x. If a rebuild picks up an older cached 1.27.0 layer, Go would attempt to download the toolchain (needs network, extra time). Pinning `golang:1.27.1-bookworm` makes the cache key explicit and the build reproducible. Reasoned from `go.mod`; *not reproduced*.
3. **Pin base images by tag plus digest** (a multi-arch index digest) once images are published, so both legs resolve the same base content.
4. **Add `--mount=type=cache` for Go and pnpm stores** if the gha layer cache proves too coarse (optional; adds BuildKit-specific syntax).
5. **Add an arm64 smoke test** in the merge job or a follow-up job on the arm runner: pull the pushed digest, run `mautrix-whatsapp --version`, `tesseract --list-langs` (expects `deu`, `eng`, `osd`), `/opt/synapse/bin/python -c "import synapse, psycopg2"`, and the app's start-up check. This is what turns "should work" into "works".
6. **`.dockerignore`** already excludes `node_modules` and `.git`, which matters because `COPY . .` would otherwise carry host-architecture native modules into the image.
7. **Re-verify wheels on dependency bumps** for `matrix-synapse` and `psycopg2-binary` (section 1), as a falling back to source build on arm64 would be slow and could fail without a Rust toolchain.

## Open items (not established by this research)

- Real wall-clock times for: native amd64, native arm64, QEMU arm64.
- Real compressed and uncompressed image sizes per platform, and `gha` cache size at `mode=max`.
- Debian bookworm arm64 availability of the apt packages (expected, unfetched).
- That `go install` of mautrix-whatsapp v0.2609.0 with `-tags goolm` links cleanly on arm64 (expected; pure Go olm, host gcc).
- Behaviour on 4 KiB vs 16 KiB page-size hosts (Raspberry Pi 5 kernels use 16 KiB pages by default on some distros) for Node, Go and Synapse's native extension. No primary source consulted.
- Whether the maintainer will make the repository public; every private-repo price above falls to zero for standard runners if so.

## Sources

- GitHub-hosted runner labels and specs: https://github.com/github/docs/blob/main/data/reusables/actions/supported-github-runners.md
- Actions runner pricing: https://github.com/github/docs/blob/main/data/reusables/billing/actions-standard-runner-prices.md and https://github.com/github/docs/blob/main/content/billing/reference/actions-runner-pricing.md
- Actions billing and included usage: https://github.com/github/docs/blob/main/content/billing/concepts/product-billing/github-actions.md, https://github.com/github/docs/blob/main/data/reusables/billing/actions-included-quotas.md
- Dependency caching limits: https://github.com/github/docs/blob/main/content/actions/reference/workflows-and-actions/dependency-caching.md
- Packages billing: https://github.com/github/docs/blob/main/content/billing/concepts/product-billing/github-packages.md
- Package visibility: https://github.com/github/docs/blob/main/content/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility.md
- Container registry: https://github.com/github/docs/blob/main/content/packages/working-with-a-github-packages-registry/working-with-the-container-registry.md
- Docker multi-platform in GitHub Actions: https://github.com/docker/docs/blob/main/content/manuals/build/ci/github-actions/multi-platform.md
- Docker multi-platform builds: https://github.com/docker/docs/blob/main/content/manuals/build/building/multi-platform.md
- Docker gha cache backend: https://github.com/docker/docs/blob/main/content/manuals/build/cache/backends/gha.md
- PyPI: https://pypi.org/pypi/matrix-synapse/1.163.2/json, https://pypi.org/pypi/psycopg2-binary/2.9.13/json
- npm: https://registry.npmjs.org/@node-rs/argon2/2.2.2, https://registry.npmjs.org/esbuild/0.28.2
- Go module proxy: https://proxy.golang.org/go.mau.fi/mautrix-whatsapp/@v/v0.2609.0.mod
- Docker Hub: https://hub.docker.com/v2/repositories/library/node/tags/24-bookworm-slim, https://hub.docker.com/v2/repositories/library/golang/tags/1.27-bookworm
