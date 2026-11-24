# Family Agenda

All text in this repo (code, comments, docs, issues, commit messages) is written in English.

## Commands

pnpm workspace, Node >=22.12. Run from repo root.

- `pnpm check` — the one command CI runs: lint + typecheck + depcruise + `crap` (all tests with coverage, CRAP ≤ 8) + `mutation` (Stryker on `packages/domain`). Run before finishing
- `pnpm test:image` — the tests of the command-line tools the image ships (poppler, Tesseract, `logto-setup`; `*.image.test.ts`). Not part of `pnpm check`: CI runs them inside the built image (`.github/container-ci/image-tests.sh <image>`). Locally they skip where a tool is missing
- `pnpm eval` — reads example messages with a real LLM (`packages/adapters/test/*.eval.ts`), by default the one a local server on port 8765 serves; `EVAL_LLM_BASE_URL`, `EVAL_LLM_MODEL`, `EVAL_LLM_API_KEY` and `EVAL_RUNS` (readings per message, default 1) choose otherwise. Not part of `pnpm check` nor CI: the user starts it by hand when needed. Agents never run it unless asked to, not after changing the extraction prompt either
- `pnpm specs` — model-checks the Quint specs of the concurrent protocols in `specs/` (ADR-0012). Not part of `pnpm check` (needs Java 17+, takes minutes); nor of CI, as a spec changes only when it is edited: run it, or one check (`pnpm specs scenarios|simulation|exhaustive|counterexample`), after changing a spec. Change a protocol's spec together with the protocol
- `pnpm preview up|down <pr>` / `list` — runs a PR as a throwaway Instance with demo data, to try it by hand. See `docs/preview.md`
- `pnpm openapi` — regenerates `packages/plugin-contract/openapi.json` after a change to the plugin contract's schemas; raise `contractVersion` too (breaking: major, additive: minor), which CI checks against the last release
- `pnpm plugins-schema` — regenerates `plugins.schema.json` after a change to the `plugins.yml` schema in `apps/api/src/plugins-file/schema.ts`
- Individually: `pnpm lint`, `pnpm typecheck`, `pnpm depcruise`, `pnpm crap`, `pnpm mutation`

The `api` project uses an in-process Postgres (migrated once via `apps/api/test/support/postgres-snapshot.ts`); no external DB needed. Tests live in `{packages,apps,tools}/*/test/`.

## Migrations

Write every migration in `packages/adapters/drizzle/` as expand/contract: older cores keep running on the new schema during a rolling update. The rule: ADR-0003, "Migrations expand, then contract".

To check a migration against the rule, describe it in `specs/rolling-update/migrations.qnt` (per release: the column the code reads each datum from, the columns it writes it to, and what the migration adds, copies and drops), add an instance for it to `specs/rolling-update/rollingUpdate_test.qnt` and to `GOOD` in its `check.sh`, then run `pnpm specs simulation`. Describe any migration that drops, renames or copies; one that only adds a table or a nullable column no older code uses needs none. A rename takes four releases after the old one when the old code writes the column (`colourRename` shows why).

## Agent skills

### Issue tracker

Issues live in GitHub Issues of `artkoenig/family-agenda`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
