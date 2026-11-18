# Stripping quoted text from a mail body

Question (#484): how reliably can quoted text be stripped from a mail body in TypeScript/Node, across Gmail, Apple Mail, Outlook, Thunderbird, German and English, plain and HTML; failure modes; licences vs AGPLv3.

Researched 2026-11-18 against the library repos and npm registry.

## Short answer

Reliable enough for the common case, never exact. No library publishes an accuracy figure; all are heuristic (regexes over quote headers plus HTML class markers). Best fit for Node: **`email-reply-parser` (crisp-oss, MIT, TS)** on the plain-text part, optionally preceded by an HTML-marker cut. Treat stripping as best-effort: keep the full body available so a wrong cut never loses data.

## Candidates

| Library | Lang | Licence | Last push | Input | Notes |
|---|---|---|---|---|---|
| [crisp-oss/email-reply-parser](https://github.com/crisp-oss/email-reply-parser) (npm `email-reply-parser` 3.0.0) | TypeScript | MIT | 2026-11 | plain text | Active. Port of GitHub's Ruby parser, extended. ~350 fixture files incl. Discourse and alfonsrv corpora. Runs ~1M mails/day at Crisp (README). Patterns written to be linear-time (ReDoS-safe, `lib/regex.ts` header comment). |
| [mailgun/talon](https://github.com/mailgun/talon) | Python | Apache-2.0 | 2026-10 | plain + HTML | Active again (v bump 2026-10). Reference implementation; not usable from Node without a Python sidecar. |
| [lever/planer](https://github.com/lever/planer) (npm `planer` 1.2.0) | CoffeeScript/JS | MIT | repo 2025-05, npm 2023-12 | plain + HTML | JS port of talon quotations (README); needs an injected DOM (jsdom). Lags talon's newer HTML fixes. Low maintenance. |
| [github/email_reply_parser](https://github.com/github/email_reply_parser) | Ruby | MIT | 2026-09 | plain | Upstream of crisp's port; English-centric. |
| [zapier/email-reply-parser](https://github.com/zapier/email-reply-parser) | Python | MIT | 2024-07 | plain | Stale. |
| [nodemailer/mailparser](https://github.com/nodemailer/mailparser) | JS | MIT (npm `license`) | 2026-11 | MIME | Parses MIME into `text`/`html`; does **no** quote stripping. Use it upstream of a stripper. |

Licences: MIT and Apache-2.0 are both compatible with AGPLv3 (Apache-2.0 is GPLv3-compatible per FSF; AGPLv3 §13 shares that compatibility). Keep the notices.

## How each client marks a quote, and coverage

Source: header regexes in [`email-reply-parser/lib/regex.ts`](https://github.com/crisp-oss/email-reply-parser/blob/master/lib/regex.ts), [`talon/quotations.py`](https://github.com/mailgun/talon/blob/master/talon/quotations.py), HTML cutters in [`talon/html_quotations.py`](https://github.com/mailgun/talon/blob/master/talon/html_quotations.py).

| Client | Plain-text marker | HTML marker | Covered by |
|---|---|---|---|
| Gmail | `On DATE, NAME <EMAIL> wrote:` / `Am DATE um TIME schrieb NAME <EMAIL>:` + `>` lines | `div.gmail_quote`, `.gmail_attr` | crisp (EN+DE regex), talon `cut_gmail_quote` |
| Apple Mail | `On DATE, at TIME, NAME wrote:` / `Am DATE um TIME schrieb NAME:` + `>` | `blockquote type="cite"` | crisp, talon `cut_blockquote` |
| Thunderbird | `On DATE NAME wrote:` / `Am DATE schrieb NAME:` + `>` | `div.moz-cite-prefix` + `blockquote type="cite"` | crisp, talon `cut_blockquote` |
| Outlook (desktop/web) | No `>`; header block `From:/Von:` + `Sent:/Gesendet:`, or `-----Original Message-----` / `-----Ursprüngliche Nachricht-----`; whole quote unprefixed | `#divRplyFwdMsg`, `border-top` separator div | crisp `fieldBlockHeader(FROM_FIELDS, SENT_FIELDS)` and separator headers; talon `cut_microsoft_quote` |

German is first-class in both crisp (`schrieb`, `schrieben Sie`, `Von:`, `Ursprüngliche Nachricht`, DE "Gesendet von"-signatures) and talon (`schrieb`, `Von`, `Gesendet`, `Datum`). A fixture `complete_german_quote_at_end.txt` exists in crisp.

## Plain vs HTML

- **Plain-text part**: most portable; every client above emits one (multipart/alternative). Header-regex approach works here. Prefer it when present.
- **HTML**: client class markers (`gmail_quote`, `divRplyFwdMsg`, `type=cite`) are more precise than text regexes when present, but are lost when a mail is forwarded/re-quoted across clients, and HTML-only mails need a DOM (jsdom) and talon/planer-style logic. No maintained TS HTML stripper exists; planer is the only JS option and lags talon.

## Failure modes

1. **Inline / interleaved replies** (answers between `>` lines, common in Thunderbird/plain-text users): header-based cut at the first quote header drops later answers. talon detects inline replies (`markers` regex `(?<=m)e*(t[te]*)m` in `quotations.py`) and then keeps the whole message; crisp splits into fragments with `quoted` flags, so caller can keep non-quoted fragments after quotes.
2. **Top-posting** (Outlook, mobile): the normal case; works when the header is recognised. Outlook's unprefixed quote depends entirely on recognising the `Von:/Gesendet:` block; a localised or customised header (other language, admin template) leaves the full thread in.
3. **Bottom-posting**: reply after the quote; header cut keeps only the quote's lead-in. crisp handles via fragments; talon handles plain `>` blocks.
4. **Forwards**: forwarded content *is* the payload (e.g. a forwarded school letter). talon explicitly preserves forwards (`_quote_is_forward`); crisp has `delimiter_before_forwarded_message` fixtures. Must be tested for our use: a forwarded mail must not be stripped.
5. **Wrapped headers**: long `On … wrote:` lines wrapped over 2 lines by clients; both libs allow one wrap (talon `SPLITTER_MAX_LINES = 6`).
6. **Signatures / mobile footers** ("Von meinem iPhone gesendet", "Get Outlook for iOS") are separate from quotes; crisp strips a list per locale.
7. **Very long mails**: talon gives up beyond `MAX_LINES_COUNT = 1000` lines; regex-heavy parsers risk ReDoS — crisp claims linear patterns.
8. **False positives**: a line in the reply that looks like a header (`Von: …`) or begins with `>` cuts real content.

## Accuracy

No library publishes a precision/recall figure; evidence is fixture suites (crisp ~350 files, talon fixtures) and production use claims (crisp: ~1M inbound/day). Expect high success for Gmail/Apple/Thunderbird top-posts in EN/DE with standard headers; weaker for Outlook with non-default headers, inline replies, and HTML-only mail.

## Recommendation for this project

1. Parse MIME with `mailparser`; take `text` (fallback: HTML→text).
2. Run crisp `email-reply-parser` (MIT, TS, maintained, DE support) and keep non-quoted fragments.
3. If the extraction step is an LLM anyway, quote stripping only reduces tokens/noise; keep it best-effort and never treat forwarded content as quote.
4. Build a small fixture set from real family mails (Gmail, iOS Mail, Outlook, Thunderbird; DE+EN; one inline reply, one forward) before relying on it.
