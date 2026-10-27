# Family Agenda

A self-hosted Instance that gathers family-relevant information from many channels into one overview of who has to be where, when, with what. See `GLOSSARY.md` for the language and `docs/adr/` for the decisions.

## Running an Instance

```sh
docker compose up -d --build
```

This starts `api` (on port 8080, or `PORT`), `worker` and `postgres`. Open the Instance in a browser: on first start it asks you to create the first Admin account, and then shows the Recovery Kit.

- **Recovery Kit**: Source credentials are encrypted with a master key that is created on first start in the `master-key` volume, never in Postgres. Print or download the Recovery Kit and keep it away from the Instance: a Backup can restore the credentials only with it. Any Admin can show it again in the Admin area.

- **Family Members and Views**: in the Admin area, add the Family Members and create Views. Each View has its own address, `/views/<id>`, which anyone on the home network opens without signing in, so guests on your Wi-Fi can see them too. Guest Wi-Fi isolation helps. Never expose the Instance to the internet without your own authentication in front of it.
- **Calendar feeds**: each View has a calendar feed at its address plus `/feed.ics`, open like the View itself. It carries the Events of the last 30 days and all future ones, whatever the View's horizon; cancelled Events stay in it as cancelled. Subscribe to it in an app that fetches the feed on the device itself, so it can reach the Instance on the home network: Apple Calendar on an iPhone, or on a Mac with the location "On My Mac"; ICSx⁵ on Android; Thunderbird; classic Outlook for Windows. Google Calendar's "From URL", Outlook.com and the new Outlook fetch from their own servers and cannot reach it. Android often cannot resolve `.local` names, so use the server's IP address there.
- **Source Types**: each kind of Source is a plugin. In the Admin area, under Source Types, enable the ones your Family uses; none is enabled on its own, not even after an update. When an update or an added plugin brings a new one, a banner says so until an Admin has looked at the list. To add a plugin to the stock image, put its package directory, with its `package.json` and code, into the `plugins` volume and restart. Such a plugin must be an ES module (`"type": "module"`) and imports `@family-agenda/source-sdk` without shipping it: it gets the Instance's own SDK. A plugin gives each text the Admin area shows (its display name, description and risk notice in the manifest; its configuration fields' labels and descriptions, setup steps and Origin attribute labels in its code) either as a plain string, shown as it is in every Family Language, or per language as `{ "en": "Calendar", "de": "Kalender" }`, where English is required and a missing language falls back to it.
- **Sources**: under Sources, add a Source of an enabled Source Type with the form its plugin declares; secret fields, such as a calendar's secret ICS address, are stored encrypted and never shown again. The `worker` checks each Source on its plugin's suggested interval, or on one you set. Its Events appear on every View. You can hide a Source from the timeline and the feeds while it is still read. Removing a Source stops reading it and removes everything it brought in.
- **ICS calendars**: add a calendar by its secret ICS address, such as Google Calendar's "Secret address in iCal format". Changed and cancelled Events follow on the next check; recurring Events are not read yet.
- **LLM endpoint**: mailboxes bring in messages, not Events. Under LLM endpoint, set the base URL of an OpenAI-compatible server and a model, such as a local Ollama (`http://ollama:11434/v1`) or a cloud provider with its API key. The key is stored encrypted. Tick "The model reads images" for a vision-capable model, such as `qwen3.5-vl`, to have scanned letters read by it. Saving a server outside your home network needs your acknowledgement that the text of third parties' messages, such as teachers' mails, is sent to it. Messages wait until an endpoint is configured, and while it cannot be reached.
- **IMAP mailboxes**: add a mailbox with its server, user name, an app password where the provider has them, and one folder. Use a folder your mail filters fill with school mail, or a mailbox only school mail is forwarded to: every mail in the folder is sent to the LLM endpoint. The plugin only reads; it never marks, moves or deletes a mail. Its first check reads the mails of the last 14 days. The `worker` has an Event extracted from each mail once; dates such as "tomorrow" count from when the mail was sent, an Event whose quote is not in the mail or whose weekday does not fit its date is rejected, and a reply in the same thread can move or cancel it. In a View, the Event's details link to the mail, which only Admins can open. PDF attachments are read as part of their mail: through their text layer with poppler, and scanned pages through the LLM endpoint if its model reads images, or with Tesseract on the Instance otherwise, in the OCR languages (see **Language**); at most 10 scanned pages per attachment. An attachment that cannot be read does not hold up its mail; the mail shows why.
- **Time zone**: a View's days start at midnight in `TZ`, by default `Europe/Berlin`.
- **Language**: the Family Language, English or German, is chosen when creating the first Admin, preselected from the browser's languages, and can be changed under Language in the settings. Views, their feeds and the Admin area speak it and write dates in it; the time zone stays with `TZ`. Under Language, an Admin also chooses the OCR languages Tesseract reads scanned letters in, in order (by default the one of the Family Language; an Instance set up before the Family Language existed keeps English dates and OCR in German). German and English come with the image; other languages are downloaded from `tesseract-ocr/tessdata_fast` into the `tessdata` volume, at a pinned commit and checked against checksums shipped with the image (ADR-0012). Without internet access, put a `<code>.traineddata` file into the volume by hand. Scanned pages are not read while a chosen language's model is missing; their mail says why.
- **Blobs**: photos, mails and their attachments are kept as files in the `blobs` volume, not in Postgres. Back it up with the database.

- **HTTPS**: the Instance serves plain HTTP. Behind your own HTTPS reverse proxy, set `TRUST_PROXY=true`, so that session cookies become `Secure` and sign-in rate limiting sees each client's address. The proxy must set `X-Forwarded-Proto` and `X-Forwarded-For`.
- **Forgotten password**: another Admin can reset it in the Admin area, or inside the container:

  ```sh
  docker compose exec api family-agenda reset-admin-password you@example.org
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

The pages use the Family Agenda design system: `apps/api/src/http/design/tokens.css` is compiled from its tokens (light, and dark when the device prefers it), and `design.css` holds its component classes, all prefixed `fam-`. The fonts, Atkinson Hyperlegible Next and Mono, come from their `@fontsource-variable` packages, and the Instance serves them itself.

After changing `packages/adapters/src/postgres/schema.ts`, generate a migration with `pnpm --filter @family-agenda/adapters exec drizzle-kit generate`. Migrations run when `api` or `worker` starts.

### Layout

| Package | Role |
| --- | --- |
| `packages/domain` | Plain TypeScript, imports nothing |
| `packages/application` | Use cases and ports |
| `packages/adapters` | Postgres (Drizzle), pg-boss, Argon2id, the master key file, the envelope-encrypting `SecretStore`, the file `BlobStore`, the OpenAI-compatible `Extractor`, the poppler and Tesseract `TextExtractor` and the `tessdata` volume of Tesseract models |
| `packages/contracts` | zod schemas for REST DTOs |
| `packages/source-sdk` | The `SourcePlugin` contract and manifest, and its shared contract tests in `@family-agenda/source-sdk/testing`; the only package a plugin may import |
| `packages/source-ics` | The ICS calendar Source plugin, on `ical.js` |
| `packages/source-imap` | The IMAP mailbox Source plugin, on `imapflow` and `mailparser` |
| `apps/api` | Hono, the composition root with the `SourceRegistry`, HTML and the CLI. Every text the pages show comes from `src/http/i18n/`: `en.ts` is the catalogue, and `de.ts` has its type, so a text missing in German does not compile |
| `apps/worker` | Polls the Sources that are due and extracts the messages they brought in, on the same composition root |

### Tests

- **Use cases**: `apps/api/test/use-cases`, booted through the composition root against a throwaway Postgres database, master key file and blob directory, with a controllable `Clock` (`apps/api/test/support/boot.ts`). Pass `secretStore: new InMemorySecretStore()` or `blobStore: new InMemoryBlobStore()` to keep secrets or blobs in memory instead, and `extractor: new ScriptedExtractor()` to answer each message with canned Events instead of calling an LLM endpoint, and `textExtractor: new FakeTextExtractor()` to read the PDFs `fakePdf` makes instead of running poppler and Tesseract, and `tessdataCatalog: new FakeTessdataCatalog()` to download stand-in Tesseract models; the `tessdata` volume starts with stand-ins for the bundled `deu`, `eng` and `osd`; `app.extraction.extractPending()` extracts the messages that wait, as the worker does.
- **Source plugin contracts**: each plugin calls `describeSourcePluginContract` from `@family-agenda/source-sdk/testing` in its own tests (with `languages: ["de"]` and its `package.json`, it also checks that every text is given in German), against recorded responses or, for IMAP, a small IMAP server fixture that records every command.
- **Source plugins in use cases**: `writeTestPluginPackage` (`apps/api/test/support/test-source-plugin.ts`) puts a test plugin into the Instance's workspace packages or `plugins/` directory; restart the Instance to discover it, or pass `sourcePlugins` to `bootForTest` to install it before the first boot. The plugin emits the Origins it is given, fails on demand, and records what it was run with. `app.polling.pollDue()` runs the Sources that are due, as the worker does.
- **Adapters**: `packages/adapters/test`, such as the poppler and Tesseract wrappers against a PDF with a text layer and a scanned one in `test/fixtures`. They need `poppler-utils`, `tesseract-ocr`, `tesseract-ocr-deu` and `tesseract-ocr-eng` installed, as the image and CI have them. Where a tool or Tesseract's German or English language data is missing, the tests that need it are skipped with a note that names it and the packages to install (`pnpm test --reporter=verbose` shows it). CI sets `REQUIRE_OCR=true`, which makes them fail instead, so OCR is never silently untested there. In Claude Code cloud sessions, a SessionStart hook (`.claude/hooks/install-ocr-tools.sh`) installs the four packages where they are missing.
- **Domain**: `packages/domain/test`, pure tests where a table of cases is clearer, such as for folding Revisions.
- **HTTP**: `apps/api/test/http`, in-process requests against the Hono app (`apps/api/test/support/http.ts`).
