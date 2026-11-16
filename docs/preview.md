# Trying a pull request by hand

`pnpm preview` runs a pull request's code as a throwaway Instance with made-up data, on your own machine, so a change can be tried by hand before it is merged. Requires Docker with Compose and `git` with access to `origin`.

```sh
pnpm preview up 189      # check out PR 189, build it, start it, seed it
pnpm preview list        # running previews, their addresses and state
pnpm preview down 189    # remove its containers, volumes, image and worktree
```

`up` prints the address, `http://localhost:<9000 + the pull request number>`. Admins sign in only through an Identity Provider (ADR-0009), so a preview brings its own: [mock-oauth2-server](https://github.com/navikt/mock-oauth2-server) at `http://localhost:<20000 + the pull request number>`. Signing in to the Admin area leads to its page: type any name and press sign in, no password or passkey. Whoever signs in there gets the group `homelab-admin`, so is an Admin.

## What it does

1. Fetches `pull/<n>/head` and checks it out into `.previews/pr-<n>`, a git worktree, so your working directory stays untouched.
2. Builds the pull request's image and the demo Source's plugin container (`tools/demo-source/Dockerfile`, from your clone).
3. Copies `tools/preview/plugins.yml` into the worktree and runs the pull request's own generator on it (`plugins generate`, see [configuration.md](configuration.md#plugins)), which writes `compose.plugins.yaml`, and the ticket key of the egress proxies in `.env`, into the worktree.
4. Starts the pull request's `compose.yaml`, the generated `compose.plugins.yaml` and the overlay `tools/preview/compose.preview.yaml` as the Compose project `fa-pr-<n>`, with its own port, images and volumes, and without the `mdns` service. The overlay names the preview's own images, also for the egress proxies (`EGRESS_PROXY_IMAGE`), and adds the mock Identity Provider `idp`, which the Instance's `OIDC_*` variables point at. It shares the network of `api`, so its issuer `http://localhost:<port>/preview` is the same address for your browser and for `api`. `down` removes it with the rest. Previews of several pull requests run side by side and beside the real Instance.
5. Seeds a demo Family: four Family Members and an Agenda for the whole Family and for each child.

The Agendas show a week of made-up Events and Lessons and two Tasks from the day you run `up`, and a Task List. They come from the **demo Source** (`tools/demo-source`), a Source plugin that states them as a calendar or timetable would. It runs as the plugin container `plugin-demo` (ADR-0001), which the core polls over REST; the worker refreshes it hourly. The seed (`tools/preview/src/seed.ts`) goes through the same use cases as the Admin area.

To try another plugin in a preview, add it to `tools/preview/plugins.yml` with a pinned image; Compose pulls it.

The seed, the demo Source, `plugins.yml` and the overlay come from the clone you run `pnpm preview` in, not from the pull request. The generator and the core come from the pull request, so only pull requests with plugin containers (`plugins generate`) can be previewed.

## Trust

A preview builds and runs the pull request's code, including its Dockerfile, with your Docker. Preview only pull requests you trust.

## What it does not cover

- Real Sources (mail, WhatsApp and other Messengers, WebUntis, the LLM). The demo's Tasks are stated by the demo Source, not extracted from a message, so the LLM path for Tasks is not exercised.
- A real Identity Provider: passkeys, group membership and sign-in refusals of your own. Previews of pull requests up to 9999 only, so the two ports stay apart.
- Reaching a preview from another device. It listens on `localhost`.
