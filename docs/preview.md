# Trying a pull request by hand

`pnpm preview` runs a pull request's code as a throwaway Instance with made-up data, on your own machine, so a change can be tried by hand before it is merged. Requires Docker with Compose and `git` with access to `origin`.

```sh
pnpm preview up 189      # check out PR 189, build it, start it, seed it
pnpm preview list        # running previews, their addresses and state
pnpm preview down 189    # remove its containers, volumes, image and worktree
```

`up` prints the address, `http://localhost:<9000 + the pull request number>`, and the Admin sign-in (`admin@example.org` / `preview-password`, public on purpose: a preview holds no real data).

## What it does

1. Fetches `pull/<n>/head` and checks it out into `.previews/pr-<n>`, a git worktree, so your working directory stays untouched.
2. Builds and starts the pull request's own `compose.yaml` as the Compose project `fa-pr-<n>`, with its own port, image and volumes, and without the `mdns` service. Previews of several pull requests run side by side and beside the real Instance.
3. Seeds a demo Family: an Admin, four Family Members and an Agenda for the whole Family and for each child.

The Agendas show a week of made-up Events and Lessons from the day you run `up`. They come from the **demo Source** (`tools/demo-source`), a Source plugin that states them as a calendar or timetable would (ADR-0016). It sits outside `packages/`, so an Instance never finds it by itself: a preview mounts it read-only into the plugins directory (ADR-0010), and the worker refreshes it hourly. The seed (`tools/preview/src/seed.ts`) goes through the same use cases as the Admin area.

The seed and the demo Source come from the clone you run `pnpm preview` in, not from the pull request, so older pull requests work too.

## Trust

A preview builds and runs the pull request's code, including its Dockerfile, with your Docker. Preview only pull requests you trust.

## What it does not cover

- Real Sources (mail, WhatsApp and other Messengers, WebUntis, the LLM). The demo has no Tasks either: Tasks only come from extracting text with the LLM, and a plugin states Events and Lessons only.
- Reaching a preview from another device. It listens on `localhost`.
