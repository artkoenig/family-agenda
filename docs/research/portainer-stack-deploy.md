# Portainer: deploying and updating the stack from a registry image

Question (issue #194, part of map #192): how does Portainer deploy and update `compose.yaml` when its services use `image: ghcr.io/artkoenig/family-agenda:<tag>`, for a public and for a private GHCR package?

Research date: 2026-11-06. **Caveat: `docs.portainer.io` could not be fetched from the research sandbox (the host is outside the session's network allowlist, `getaddrinfo ENOTFOUND` and proxy 403). Every Portainer claim below comes from search-engine extracts of the official pages linked, not from reading the pages. GHCR and Docker Compose claims come from prior knowledge and were not fetched at all.** Items marked *unverified* need checking against the linked page before they go into user-facing docs. Re-run this note with `docs.portainer.io`, `docs.github.com` and `docs.docker.com` allowed to close the gaps.

## What `compose.yaml` needs for this to work (from the repo, verified)

- Today `x-app` has `build: .` and `image: family-agenda:local`, and `mdns` uses `image: family-agenda:local`. A stack pasted into Portainer's web editor has no build context, so a registry deployment needs a separate compose file (or an override) whose `api`, `worker` and `mdns` all say `image: ghcr.io/artkoenig/family-agenda:<tag>` and no `build:`.
- `api`, `worker` and `mdns` share one image. They must be moved to the same tag together; with a single YAML anchor or a `${FAMILY_AGENDA_IMAGE}`-style variable that is one edit.
- `mdns` uses `network_mode: host`, `worker` uses `init: true`, and seven named volumes are declared (`postgres-data`, `master-key`, `blobs`, `plugins`, `tessdata`, `matrix-instance`, `matrix-data`).

## Findings

### 1. Web editor stack versus Git repository stack

- Portainer offers several ways to create a stack, including the web editor, upload and Git repository ([Add a new stack](https://docs.portainer.io/user/docker/stacks/add)).
- A web-editor or uploaded stack keeps its compose file inside Portainer and is edited by hand in the stack's Editor tab ([Inspect or edit a stack](https://docs.portainer.io/user/docker/stacks/edit)). The Family therefore copies the file once and owns it; a new release's compose changes (a new volume, a new env var) are not picked up unless the Family pastes them in.
- A Git stack takes a repository URL, reference and compose path, and can be updated by polling or a webhook ([Add a new stack](https://docs.portainer.io/user/docker/stacks/add), [How do automatic updates for stacks/applications work?](https://docs.portainer.io/faqs/troubleshooting/stacks-deployments-and-updates/how-do-automatic-updates-for-stacks-applications-work)). The compose file then follows a ref (a tag, for a pinned release; a branch, for the moving channel).
- For a **private** repository a Git stack needs Git credentials (a token) saved in Portainer (*authentication fields unverified; read the Git section of the Add a new stack page*). A public repository needs none. While the repository is private, a Family would need a token just to read the compose file, so a web-editor stack with a pasted file, or a compose file published as a release asset, is the lower-friction option for now. *Whether the maintainer wants Families to follow the Git repository at all is a decision for the map (#192), not this ticket.*
- Variables: Portainer has an environment-variables section on the stack form, which feeds the `${VAR:-default}` substitutions in `compose.yaml` (`PORT`, `PUBLIC_URL`, `POSTGRES_PASSWORD`, `TZ`, `MDNS_NAME`, `TRUST_PROXY`) (*unverified from the page; confirm that variables are substituted, that a `.env` file can be loaded into the form, and whether a `.env` file in a Git repository is read*). `docs/configuration.md` already tells users to set variables "in your stack tool (Portainer, ...)".

### 2. Updates: moving tag versus exact version

- **Git stack, automatic updates.** Two mechanisms: *polling* (Portainer checks the repository every fetch interval) and *webhook* (a URL that triggers an update on demand, for example from GitHub Actions). Portainer compares the latest commit hash with the one stored at the last deploy and redeploys only if they differ; it does not force a redeploy if the image did not change. A toggle forces a redeploy at every interval or webhook call even without new commits ([How do automatic updates work?](https://docs.portainer.io/faqs/troubleshooting/stacks-deployments-and-updates/how-do-automatic-updates-for-stacks-applications-work), [Add a new stack](https://docs.portainer.io/user/docker/stacks/add)).
- **Consequence for a moving tag.** A moving tag (`main`, `latest`) changes in the registry, not in Git, so commit-hash polling never notices it. The compose file must also be redeployed with **Re-pull image and redeploy**, which forces Docker to fetch the current images even if a local copy exists and may interrupt service ([Inspect or edit a stack](https://docs.portainer.io/user/docker/stacks/edit)). The extract describes this option for Git-deployed stacks; the web-editor stack's Update button also has a re-pull toggle in recent versions (*unverified; check the page*). Without re-pull, Docker Compose reuses a local image with the same tag (*Compose default `pull_policy: missing`, unverified here*).
- **Exact version.** Changing the tag in the compose file (editor) or the Git ref and redeploying updates all three services together. Nothing is pulled silently, so this suits a Family that wants control.
- **Image update indicators.** Portainer compares the local image digest with the remote digest on page refresh (with caching) and shows a green tick, an orange cross or a grey hyphen; per-stack "Reload image indicators" rechecks. The page states the feature is **Business Edition only** ([How does the image update notification icon work?](https://docs.portainer.io/faqs/troubleshooting/stacks-deployments-and-updates/how-does-the-image-update-notification-icon-work), [enable/disable indicator](https://docs.portainer.io/faqs/troubleshooting/certificates-and-security/how-to-enable-disable-image-up-to-date-indicator)). Do not rely on it for Community Edition Families.
- **Stack webhooks** have their own page ([Webhooks](https://docs.portainer.io/user/docker/stacks/webhooks)). Not read; *unverified whether it is Community or Business Edition and whether it re-pulls the image*. It is the likely way to let a "main" channel redeploy on every push.
- Edge GitOps updates are Business Edition ([Add a new stack](https://docs.portainer.io/user/docker/stacks/add) extract); this stack is a normal Docker stack, so that does not apply.

### 3. Constraints of this stack under Portainer

All *unverified against Portainer docs*; no extract mentioned them.
- `network_mode: host`, `init: true`, YAML anchors and `depends_on` conditions are Docker Compose features. Portainer deploys standalone stacks with Docker Compose, so they should work as on the CLI. The `mdns` caveat from `compose.yaml` (Linux host only, not Docker Desktop) applies the same; a Portainer environment on a remote Docker host is fine, as is a NAS.
- Volume names: Docker Compose prefixes named volumes with the *project name*. Portainer sets the project name from the stack name, which (per Compose precedence) overrides the top-level `name: family-agenda`. The release notes' `family-agenda_*` volume names therefore hold only if the stack is named `family-agenda` in Portainer. A different stack name creates empty new volumes, and an existing install migrated into Portainer would lose its data unless names match. Worth stating in the install docs.
- Relative bind mounts break on Git stack redeploys ([FAQ](https://docs.portainer.io/portainer-documentation/sts/faqs/troubleshooting/stacks-deployments-and-updates/empty-relative-bind-mounts)); this stack uses only named volumes, so it is unaffected.
- `restart: unless-stopped` and the healthchecks work as usual. Re-pull recreates all containers of the stack, including `postgres`, for a moment. Data is on named volumes and survives.

### 4. Pulling from GHCR

- Portainer's release notes record fixes for private-registry pulls during forced re-pulls (a standard stack failing to pull private images during a GitOps update with Re-pull enabled and a relative path; a Swarm stack failing to re-pull private Docker Hub images) ([Release Notes](https://docs.portainer.io/release-notes)). Neither mentions `ghcr.io`.
- **Public package:** a public GHCR image can be pulled anonymously, so no registry needs to be configured in Portainer (*GitHub behaviour, from prior knowledge; not fetched; confirm on docs.github.com "Working with the Container registry"*).
- **Private package:** add `ghcr.io` as a registry in Portainer (Registries, a custom registry with the username and a personal access token that has `read:packages`), after which Portainer uses those credentials when it deploys and re-pulls images from that registry (*unverified; read the Portainer Registries pages and GitHub's token documentation*).
- **Package visibility is separate from repository visibility** on GitHub (*prior knowledge, unverified*): if the repository later becomes public, the published package may still be private until its visibility is changed in the package settings. Check this when the repository is made public, since the install docs should promise "no credentials" only if the package is public.

## Open items to verify (needs `docs.portainer.io` / `docs.github.com` access)

1. Whether the web-editor Update dialog has a re-pull toggle on the current LTS and STS, and whether stack webhooks re-pull images, in Community Edition.
2. Environment-variable handling for Git and editor stacks (`.env` loading, substitution).
3. Git stack authentication options for a private repository.
4. Exact `ghcr.io` registry setup in Portainer and the minimum token scope.
5. Package visibility rules when a repository becomes public.
