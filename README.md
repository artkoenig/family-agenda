# Family Butler

A self-hosted Instance that gathers family-relevant information from many channels into one overview of who has to be where, when, with what. See `GLOSSARY.md` for the language and `docs/adr/` for the decisions.

## Running an Instance

```sh
docker compose up -d --build
```

This starts `api` (on port 8080, or `PORT`), `worker` and `postgres`. Open the Instance in a browser: on first start it asks you to create the first Admin account.

- **HTTPS**: the Instance serves plain HTTP. Behind your own HTTPS reverse proxy, set `TRUST_PROXY=true`, so that session cookies become `Secure` and sign-in rate limiting sees each client's address. The proxy must set `X-Forwarded-Proto` and `X-Forwarded-For`.
- **Forgotten password**: another Admin can reset it in the Admin area, or inside the container:

  ```sh
  docker compose exec api family-butler reset-admin-password you@example.org
  ```

  It prints a new password and ends that Admin's sessions.

## Development

Requires Node.js LTS, pnpm and a Postgres server for the tests (`TEST_DATABASE_URL`, by default `postgres://postgres:postgres@localhost:5432/postgres`). Each test file creates and drops its own database.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm depcruise   # package boundaries of the Clean Architecture
pnpm test
```

After changing `packages/adapters/src/postgres/schema.ts`, generate a migration with `pnpm --filter @family-butler/adapters exec drizzle-kit generate`. Migrations run when `api` or `worker` starts.

### Layout

| Package | Role |
| --- | --- |
| `packages/domain` | Plain TypeScript, imports nothing |
| `packages/application` | Use cases and ports |
| `packages/adapters` | Postgres (Drizzle), pg-boss, Argon2id |
| `packages/contracts` | zod schemas for REST DTOs |
| `packages/source-sdk` | The `SourcePlugin` contract, and its shared contract tests in `@family-butler/source-sdk/testing` |
| `apps/api` | Hono, the composition root, HTML and the CLI |
| `apps/worker` | pg-boss jobs, on the same composition root |

### Tests

- **Use cases**: `apps/api/test/use-cases`, booted through the composition root against a throwaway Postgres database with a controllable `Clock` (`apps/api/test/support/boot.ts`).
- **Source plugin contracts**: each plugin calls `describeSourcePluginContract` from `@family-butler/source-sdk/testing` in its own tests.
- **HTTP**: `apps/api/test/http`, in-process requests against the Hono app (`apps/api/test/support/http.ts`).
