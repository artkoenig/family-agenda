# Family Butler

A self-hosted Instance that gathers family-relevant information from many channels into one overview of who has to be where, when, with what. See `GLOSSARY.md` for the language and `docs/adr/` for the decisions.

## Running an Instance

```sh
docker compose up -d --build
```

This starts `api` (on port 8080, or `PORT`), `worker` and `postgres`. Open the Instance in a browser: on first start it asks you to create the first Admin account, and then shows the Recovery Kit.

- **Recovery Kit**: Source credentials are encrypted with a master key that is created on first start in the `master-key` volume, never in Postgres. Print or download the Recovery Kit and keep it away from the Instance: a Backup can restore the credentials only with it. Any Admin can show it again in the Admin area.

- **Family Members and Views**: in the Admin area, add the Family Members and create Views. Each View has its own address, `/views/<id>`, which anyone on the home network opens without signing in, so guests on your Wi-Fi can see them too. Guest Wi-Fi isolation helps. Never expose the Instance to the internet without your own authentication in front of it.
- **Calendar feeds**: each View has a calendar feed at its address plus `/feed.ics`, open like the View itself. It carries the Events of the last 30 days and all future ones, whatever the View's horizon; cancelled Events stay in it as cancelled. Subscribe to it in an app that fetches the feed on the device itself, so it can reach the Instance on the home network: Apple Calendar on an iPhone, or on a Mac with the location "On My Mac"; ICSx⁵ on Android; Thunderbird; classic Outlook for Windows. Google Calendar's "From URL", Outlook.com and the new Outlook fetch from their own servers and cannot reach it. Android often cannot resolve `.local` names, so use the server's IP address there.
- **Source Types**: each kind of Source is a plugin. In the Admin area, under Source Types, enable the ones your Family uses; none is enabled on its own, not even after an update. When an update or an added plugin brings a new one, a banner says so until an Admin has looked at the list. To add a plugin to the stock image, put its package directory, with its `package.json` and code, into the `plugins` volume and restart. Such a plugin must be an ES module (`"type": "module"`) and imports `@family-butler/source-sdk` without shipping it: it gets the Instance's own SDK.
- **Sources**: under Sources, add a Source of an enabled Source Type with the form its plugin declares; secret fields, such as a calendar's secret ICS address, are stored encrypted and never shown again. The `worker` checks each Source on its plugin's suggested interval, or on one you set. Its Events appear on every View. Removing a Source stops reading it, but what it brought in stays.
- **ICS calendars**: add a calendar by its secret ICS address, such as Google Calendar's "Secret address in iCal format". Changed and cancelled Events follow on the next check; recurring Events are not read yet.
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
| `packages/source-sdk` | The `SourcePlugin` contract and manifest, and its shared contract tests in `@family-butler/source-sdk/testing`; the only package a plugin may import |
| `packages/source-ics` | The ICS calendar Source plugin, on `ical.js` |
| `apps/api` | Hono, the composition root with the `SourceRegistry`, HTML and the CLI |
| `apps/worker` | Polls the Sources that are due, on the same composition root |

### Tests

- **Use cases**: `apps/api/test/use-cases`, booted through the composition root against a throwaway Postgres database, master key file and blob directory, with a controllable `Clock` (`apps/api/test/support/boot.ts`). Pass `secretStore: new InMemorySecretStore()` to keep secrets in memory instead.
- **Source plugin contracts**: each plugin calls `describeSourcePluginContract` from `@family-butler/source-sdk/testing` in its own tests.
- **Source plugins in use cases**: `writeTestPluginPackage` (`apps/api/test/support/test-source-plugin.ts`) puts a test plugin into the Instance's workspace packages or `plugins/` directory; restart the Instance to discover it, or pass `sourcePlugins` to `bootForTest` to install it before the first boot. The plugin emits the Origins it is given, fails on demand, and records what it was run with. `app.polling.pollDue()` runs the Sources that are due, as the worker does.
- **Domain**: `packages/domain/test`, pure tests where a table of cases is clearer, such as for folding Revisions.
- **HTTP**: `apps/api/test/http`, in-process requests against the Hono app (`apps/api/test/support/http.ts`).
