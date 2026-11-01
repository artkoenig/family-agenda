# Family Agenda

All text in this repo (code, comments, docs, issues, commit messages) is written in English.

## Commands

pnpm workspace, Node >=22.12. Run from repo root.

- `pnpm test` — all tests (vitest, two projects: `packages` and `api`)
- `pnpm test --project packages` / `pnpm test --project api` — one project
- `pnpm vitest run path/to/file.test.ts` — single file; add `-t "name"` for one test
- `pnpm vitest` — watch mode
- `pnpm check` — lint + typecheck + depcruise + test (run before finishing)
- Individually: `pnpm lint`, `pnpm typecheck`, `pnpm depcruise`

The `api` project uses an in-process Postgres (migrated once via `apps/api/test/support/postgres-snapshot.ts`); no external DB needed. Tests live in `{packages,apps}/*/test/`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues of `artkoenig/family-buttler`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
