# Family Butler

A self-hosted Instance that gathers family-relevant information from many channels into one overview of who has to be where, when, with what. See `GLOSSARY.md` for the language and `docs/adr/` for the decisions.

## Running an Instance

```sh
docker compose up -d --build
```

This starts `api` (on port 8080, or `PORT`), `worker` and `postgres`. Open the Instance in a browser: on first start it asks you to create the first Admin account, and then shows the Recovery Kit.

- **Recovery Kit**: Source credentials are encrypted with a master key that is created on first start in the `master-key` volume, never in Postgres. Print or download the Recovery Kit and keep it away from the Instance: a Backup can restore the credentials only with it. Any Admin can show it again in the Admin area.

- **Family Members and Views**: in the Admin area, add the Family Members and create Views. Each View has its own address, `/views/<id>`, which anyone on the home network opens without signing in, so guests on your Wi-Fi can see them too. Guest Wi-Fi isolation helps. Never expose the Instance to the internet without your own authentication in front of it.
- **Time zone**: a View's days start at midnight in `TZ`, by default `Europe/Berlin`.
- **Blobs**: photos are kept as files in the `blobs` volume, not in Postgres. Back it up with the database.

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
| `packages/adapters` | Postgres (Drizzle), pg-boss, Argon2id, the master key file, the envelope-encrypting `SecretStore` and the file `BlobStore` |
| `packages/contracts` | zod schemas for REST DTOs |
| `packages/source-sdk` | The `SourcePlugin` contract, and its shared contract tests in `@family-butler/source-sdk/testing` |
| `apps/api` | Hono, the composition root, HTML and the CLI |
| `apps/worker` | pg-boss jobs, on the same composition root |

### Tests

- **Use cases**: `apps/api/test/use-cases`, booted through the composition root against a throwaway Postgres database, master key file and blob directory, with a controllable `Clock` (`apps/api/test/support/boot.ts`). Pass `secretStore: new InMemorySecretStore()` to keep secrets in memory instead.
- **Source plugin contracts**: each plugin calls `describeSourcePluginContract` from `@family-butler/source-sdk/testing` in its own tests.
- **HTTP**: `apps/api/test/http`, in-process requests against the Hono app (`apps/api/test/support/http.ts`).
