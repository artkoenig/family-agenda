# What a mail reply looks like when it reaches Extraction

Question: #483. Traced at family-agenda `02de89c` and family-agenda-imap `9482955` (release 0.3.0, the image pinned in `plugins.yml`).

## Path

1. **IMAP plugin** (external repo `artkoenig/family-agenda-imap`, `src/mail.ts` `recordOf`) parses the raw RFC 822 source with `mailparser` 3.14.1 `simpleParser` and emits a `SourceRecord`:
   - `externalId` = `Message-ID` (fallback `uid:<uidValidity>:<uid>`)
   - `occurredAt` = IMAP INTERNALDATE (fallback `Date` header)
   - `sender` = first `From` address, lower-cased; `subject`
   - `content.kind = "raw-message"`, `text` = `"Subject: <subject>\n\n" + parsed.text` (CRLF -> LF, trimmed), attachments without inline (`related`) images.
2. **Plugin contract** (`packages/plugin-contract/src/index.ts`, `sourceRecordSchema`): fields are only `externalId, occurredAt, attributes, sender, subject, link, content`. No headers field.
3. **Core** (`packages/application/src/polling.ts` `stored`): stores `sender`, `subject`, `body = text`, attachments in BlobStore.
4. **Extraction** (`packages/application/src/extraction.ts` `fullTextOf`): body + text of PDF attachments joined; no quote stripping anywhere (grep for quote/reply/schrieb finds nothing besides evidence checks).
5. **Prompt** (`packages/adapters/src/openai-compatible-extractor.ts` `promptOf`): sent date line + `<<<` text `>>>`. System prompt (`instructions`) says nothing about quoted replies.

## Answers

**Body format.** `parsed.text` from mailparser (`dist/cjs/mail-parser.js` ~l.795-845): the `text/plain` part when the mail has one (in `multipart/alternative` the HTML is not converted); for HTML-only mails, `html-to-text` 10.0.1 with default options. So plain text, HTML-derived only for HTML-only mails.

**Quotes intact?** Yes. Nothing in plugin or core removes them:
- `>` lines, "Am … schrieb …:" attribution, Outlook "Von:/Gesendet:/An:/Betreff:" blocks all pass verbatim in the text part.
- `<blockquote>` in HTML-only mails: html-to-text's default blockquote formatter renders it as `> `-prefixed lines, so still present.
So a reply reaches the LLM with the full original mail below it, and the LLM extracts the original's Items again -> duplicates.

**Headers read / passed.** Plugin reads only `Message-ID`, `From`, `Subject`, `Date` (fallback). mailparser already parses `In-Reply-To` (`parsed.inReplyTo`) and `References` (`parsed.references`), but the plugin ignores them, and the contract has no field to carry them. Passing them needs an additive contract field (e.g. `inReplyTo?: string[]` / `references`; minor `contractVersion` bump, `pnpm openapi`) plus a plugin release.

**Can the core find the replied-to Source Record today?** No. A reply has its own `Message-ID`, so it is not a Copy (ADR-0005, "Copies of a message": equality of external ids only; "a forwarded mail has another external id and is read on its own"). The core receives no `In-Reply-To`/`References` and stores none. Once passed, lookup would be feasible: the referenced ids equal the `externalId` of the original's Source Record(s) in Sources of the same Source Type (IMAP plugin uses Message-ID as externalId), unless the original lacked a Message-ID or never reached any Source.

## Sources
- family-agenda-imap `src/mail.ts`, `package.json` (mailparser 3.14.1)
- mailparser 3.14.1 `dist/cjs/mail-parser.js` (text/html selection, header parsing incl. `in-reply-to`, `references`), `package.json` (html-to-text 10.0.1)
- `packages/plugin-contract/src/index.ts`, `packages/application/src/polling.ts`, `packages/application/src/extraction.ts`, `packages/adapters/src/openai-compatible-extractor.ts`
- `docs/adr/0005-items-are-written-from-their-one-source-record.md`
