# Running Family Agenda in Portainer

Portainer runs the same `compose.yaml` as the command line. This page covers what is different there. It was written from the Portainer documentation (2.45 LTS) and the Portainer source; the points marked *unverified* have not been tried in a running Portainer yet.

## Before you start

- The image comes from `ghcr.io/artkoenig/family-agenda`. As a public package it needs no registry set up in Portainer. If a package is private, add a custom registry in Portainer: URL `ghcr.io`, your GitHub user name, and a classic personal access token with `read:packages` as the password. (Portainer's own GitHub registry type is Business Edition only and asks for much wider token scopes.)
- `mdns` uses the host network and works on a Linux host only, as on the command line.
- **Name the stack `family-agenda`.** Portainer's stack name, not the `name:` in the file, gives the volumes their prefix. Under another name the stack starts with empty volumes and your data looks gone. Everything in [upgrading.md](upgrading.md) assumes that name.

## Create the stack from Git (recommended)

A Git stack follows a reference of this repository, so a new release brings its changes to the compose file, such as a new volume or setting, with it.

1. Stacks, Add stack, Repository.
2. Name: `family-agenda`.
3. Repository URL: `https://github.com/artkoenig/family-agenda`. It is public, so no authentication is needed.
4. Repository reference: the tag of the release, for example `refs/tags/v0.1.0`.
5. Compose path: `compose.yaml`.
6. Environment variables: add the ones you need, or use **Load variables from .env file** with `.env.example` from this repository. See [configuration.md](configuration.md).
7. Deploy the stack.

The compose file of a release names that release as its default version, so a stack on the tag `v0.1.0` runs `0.1.0` without any variable set. Do not set `FAMILY_AGENDA_VERSION` unless you want to differ from it: a value kept in Portainer outlives a change of the reference.

## Create the stack in the web editor

Paste the `compose.yaml` that is attached to the GitHub Release into the web editor. The stack then keeps its own copy. A later release that changes the compose file, with a new volume or setting, does not reach it: paste the new file in when you upgrade. The web editor is the simpler start, the Git stack the less work later.

## Upgrade

1. Read the **Upgrading** section of the release and make a backup, see [upgrading.md](upgrading.md).
2. Git stack: change the repository reference to the new tag and redeploy. Web editor: paste the new `compose.yaml`.
3. Turn on **Re-pull image** if you follow `latest` or `main`; for an exact version Portainer pulls the image on its own, because the image is not on the host yet.

Following `latest` or `main` needs care. Portainer notices a change in Git, not in the registry, so automatic updates of the stack never see a new image under the same tag. In Community Edition use a Git stack with **Force redeployment** and **Re-pull image** switched on in its automatic updates, or update by hand with **Pull and redeploy** and **Re-pull image and redeploy** switched on. For the web editor, Portainer's documentation describes no re-pull switch, so pin an exact version there (*unverified in the user interface*). Webhooks and the image update indicator that would notice a new image are Business Edition features.

A forced redeploy recreates the containers whose image or configuration changed, which briefly interrupts the Instance. The data stays on the volumes.
