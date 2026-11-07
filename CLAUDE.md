# Family Agenda

All text in this repo (code, comments, docs, issues, commit messages) is written in English.

## Commands

pnpm workspace, Node >=22.12. Run from repo root.

- `pnpm check` — the one command CI runs: lint + typecheck + depcruise + `api-version` (public API of each package vs. its version since the last release; `pnpm sdk-api` rewrites the `api.txt` files) + `crap` (all tests with coverage, CRAP ≤ 8) + `mutation` (Stryker on `packages/domain`). Run before finishing
- `pnpm preview up|down <pr>` / `list` — runs a PR as a throwaway Instance with demo data, to try it by hand. See `docs/preview.md`
- Individually: `pnpm lint`, `pnpm typecheck`, `pnpm depcruise`, `pnpm crap`, `pnpm mutation`

The `api` project uses an in-process Postgres (migrated once via `apps/api/test/support/postgres-snapshot.ts`); no external DB needed. Tests live in `{packages,apps,tools}/*/test/`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues of `artkoenig/family-agenda`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
