# Mailbox Source ingestion: getting mail and PDF attachments into text

Question (issue #5): how should Family Agenda read a family mailbox **Source** (IMAP vs. Gmail API vs. a dedicated forwarding address), select only relevant mail, and turn PDF attachments (school letters, often scanned) into text that the LLM can extract **Items** from?

Research date: 2026-10-25. Note: Google, Microsoft, IETF and Hugging Face hosts could not be fetched directly from the research sandbox. Claims about them come from search-engine extracts of the official pages linked. Library and model claims were read directly from the projects' GitHub READMEs, source and LICENSE files. Items marked *unverified* need checking before implementation.

## Part 1: getting the mail

### Options

| | IMAP (poll or IDLE) | Gmail API | Dedicated forwarding address |
|---|---|---|---|
| Providers | Any: GMX, web.de, T-Online, mailbox.org, iCloud, Gmail, Outlook.com | Gmail / Google Workspace only | Any (parents set a forward rule in their own mailbox) |
| Auth | Password or app password for most German providers. Gmail: app password (needs 2-Step Verification) or OAuth (XOAUTH2). Outlook.com: OAuth only | OAuth 2.0 with the Family's own Google Cloud project | Whatever the receiving mailbox needs, usually a plain IMAP login |
| Freshness | Poll every few minutes, or IDLE for push-like delivery | Poll `history.list`, or push via Cloud Pub/Sub `watch` | Same as the receiving side |
| Access scope | Whole mailbox, unless we restrict ourselves to one folder | Whole mailbox (`gmail.readonly` is a restricted scope) | Only the mail the parents chose to forward |
| Setup for one self-hosted Family | Host, port, user, password | GCP project, consent screen, OAuth client, redirect URI; Testing-mode tokens expire after 7 days | A second mailbox plus provider-side forward/filter rules |

### Findings

**IMAP is the only option that works across the providers a German Family is likely to use.**
- Google switched off password-only ("less secure app") sign-in for IMAP, POP, SMTP, CalDAV and CardDAV on 14 March 2025. Apps must use OAuth, with app passwords as the remaining exception ([Workspace: transition from less secure apps to OAuth](https://knowledge.workspace.google.com/admin/sync/transition-from-less-secure-apps-to-oauth), [2023 announcement](https://workspaceupdates.googleblog.com/2023/09/winding-down-google-sync-and-less-secure-apps-support.html)).
- Google app passwords are 16-character passcodes, available only with 2-Step Verification, discouraged by Google, and revoked whenever the account password changes ([Sign in with app passwords](https://support.google.com/accounts/answer/185833)).
- Outlook.com personal accounts no longer accept Basic auth for IMAP/POP/SMTP; OAuth is required. Microsoft announced it in 2024; the 16 September 2024 cut-off date comes from secondary sources ([Microsoft support](https://support.microsoft.com/office/outlook-and-other-apps-are-unable-to-connect-to-outlook-com-f4202ebf-89c6-4a8a-bec3-3d60cf7deaef)). *Exact date unverified.*
- GMX/web.de: IMAP access is off by default and must be enabled under Settings → "POP3/IMAP Abruf". With 2FA enabled an application-specific password is needed (community and press sources, e.g. [giga.de](https://www.giga.de/tipp/gmx-imap-pop3-aktivieren-einrichten-e-mail-client/); *not confirmed on GMX's own help pages*).
- Gmail exposes labels as IMAP folders and adds `X-GM-RAW`, which accepts full Gmail search syntax in IMAP `SEARCH`, plus stable `X-GM-MSGID`/`X-GM-THRID` IDs ([Gmail IMAP extensions](https://developers.google.com/workspace/gmail/imap/imap-extensions)).
- Read-only by construction (IMAP standard behaviour, RFC 3501/9051): open the folder with `EXAMINE` (read-only `SELECT`) and fetch with `BODY.PEEK[]`, so the `\Seen` flag is never set. Track `UIDVALIDITY` + `UID` to avoid re-processing. This differs from paperless-ngx, which marks, flags, moves or tags mail to avoid consuming it twice ([paperless-ngx mail docs](https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/usage.md#incoming-email)). Family Agenda only reads, so it should not change the mailbox.
- IDLE (RFC 2177) gives near-instant delivery but servers drop idle connections, so a client must re-issue IDLE periodically (the RFC advises at least every 29 minutes). Polling every 2-5 minutes is simpler and fresh enough for school letters. Python: `imapclient` (New BSD) supports IDLE ([README](https://github.com/mjs/imapclient)).

**The Gmail API buys little for this use case and costs a lot of setup.**
- Gmail read scopes are *restricted*. Publishing an app that uses them requires Google verification and a security assessment. In "Testing" status (no verification), refresh tokens for non-basic scopes expire after 7 days, which means re-consenting every week (search extracts of [Google OAuth docs](https://developers.google.com/identity/protocols/oauth2) and [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)). The same constraint hits Gmail over IMAP with OAuth, so for Gmail an **app password over IMAP** is the pragmatic self-hosted path.
- Push (`users.watch`) needs a Cloud Pub/Sub topic and must be renewed at least every 7 days ([push guide](https://developers.google.com/workspace/gmail/api/guides/push); *details from prior knowledge, page not fetched*). A pull subscription avoids a public webhook but still ties the install to GCP.

**A dedicated forwarding address is the best privacy story, and it still ends in IMAP.**
- Parents create one extra mailbox (e.g. `familie-agenda@<provider>`) and add rules in their own mailboxes that forward school, club and doctor mail to it. Family Agenda holds credentials only for that mailbox, never for the parents' private mail.
- Running our own SMTP receiver instead (MX record, inbound port 25) is a poor fit for a home install: residential ISPs often block port 25 and it adds spam handling. Treat it as out of scope.
- Caveats: Gmail asks the user to confirm the forwarding address first (*unverified detail*). A *manually* forwarded mail wraps the original as quoted text or a `message/rfc822` attachment, so the parser must unwrap it to find the real sender and date.

### Selecting relevant mail
Use three layers, cheapest first:
1. **Provider-side filter into a folder/label.** The parent creates a rule such as `from:(@schule-xyz.de OR @elternportal.de) → label "Family Agenda"` (Gmail) or a GMX/web.de filter that moves mail into a folder. Family Agenda reads only that folder. This is the same approach paperless-ngx recommends ("set up a special folder... and use your mail client to move mails into that folder").
2. **Sender/subject allow-list in Family Agenda's own Source config** (domains, addresses, subject keywords), plus a maximum age. On Gmail this can be pushed down to the server with `X-GM-RAW`.
3. **LLM relevance check** on what passes: "does this concern a Family Member; which Item types?" Low-confidence results go to the Admin review.

Reading the whole inbox and relying on the LLM alone is not advisable: it costs tokens, and it sends unrelated private mail to a possibly remote LLM.

## Part 2: PDF attachments to text

### Digital PDFs (they have a text layer)
| Library | Licence | Notes |
|---|---|---|
| [pypdf](https://github.com/py-pdf/pypdf) | BSD-3-Clause | Pure Python, `extract_text()`; good enough for letters |
| [pdfplumber](https://github.com/jsvine/pdfplumber) | MIT | Built on pdfminer.six; better layout and tables |
| [pypdfium2](https://github.com/pypdfium2-team/pypdfium2) | Apache-2.0 / BSD-3 (PDFium: BSD-style) | Fast text extraction **and** page rasterising for OCR/vision |
| [PyMuPDF](https://github.com/pymupdf/PyMuPDF) | AGPL-3.0 (or commercial) | Fast and capable. The repo is GPL-3.0, and AGPL-3.0 may be combined with GPL-3.0, but the network-use clause then applies to that part |

Scan detection: if a page yields no text, or only a few characters, treat it as a scan and send it to OCR or vision. School letters are often printed, signed and scanned at the school copier, so expect a high share of image-only PDFs.

### OCR for scans

| Engine | Licence | Hardware | German | Notes |
|---|---|---|---|---|
| [Tesseract](https://github.com/tesseract-ocr/tesseract) 5 (LSTM) + [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) | Apache-2.0 (engine and [tessdata_best](https://github.com/tesseract-ocr/tessdata_best)); OCRmyPDF MPL-2.0 | CPU only, all cores, small footprint | Dedicated `deu` model (plus `deu_frak` for Fraktur) | Mature; adds a text layer to the PDF. Weak on poor scans, tables and reading order |
| [docTR](https://github.com/mindee/doctr) | Apache-2.0 | CPU workable, GPU better (PyTorch) | **Default pretrained recognition models use the `french` vocab, which lacks ä, ö, ß** ([vocabs.py](https://github.com/mindee/doctr/blob/main/doctr/datasets/vocabs.py), [crnn](https://github.com/mindee/doctr/blob/main/doctr/models/recognition/crnn/pytorch.py)). A `german` vocab and a `multilingual` vocab exist; a whitelist only restricts, it cannot add characters | Needs a multilingual or German-trained checkpoint to be usable |
| [Docling](https://github.com/docling-project/docling) | MIT (models: per-package licences) | CPU fine; GPU optional | Delegates OCR to Tesseract, EasyOCR, RapidOCR, etc.; `OcrAutoOptions(lang=["iso:de"])` picks an engine that has a German model ([pipeline_options.py](https://github.com/docling-project/docling/blob/main/docling/datamodel/pipeline_options.py)) | Strong layout and tables, outputs Markdown/JSON; also parses `.eml`. Heavy dependency tree |
| [Marker](https://github.com/datalab-to/marker) / [Surya](https://github.com/datalab-to/surya) | Code Apache-2.0; **model weights modified OpenRAIL-M** (free for personal use and orgs under $5M revenue/funding) | OCR runs a Surya VLM through vLLM (NVIDIA GPU) or llama.cpp (CPU, slow); `--disable_ocr` is CPU-only but skips scans | Surya reports 89.7% on its internal German test (87.2% across 91 languages) | Best open benchmark scores (olmOCR-bench 76.0 balanced on GPU vs docling 50.3) |
| [olmOCR](https://github.com/allenai/olmocr) | Apache-2.0 | 7B VLM, NVIDIA GPU with at least 12 GB VRAM | Trained and filtered mainly on English PDFs; *German quality unverified* | Overkill for a few letters a week |

Benchmarks: [olmOCR-bench](https://github.com/allenai/olmocr/tree/main/olmocr/bench) (1,400 PDFs) is the most-cited open comparison, but it is English-centric and the Marker figures are Marker's own runs. No primary benchmark found for German school-letter-like scans: **test on a dozen real letters before choosing.**

### Sending page images to a vision-capable LLM
- Rasterise each page (pypdfium2, roughly 150-200 DPI) and send the images, or the PDF itself where the API accepts PDFs. Ask for the transcription and the structured Items in one call. Vision LLMs handle German, umlauts, stamps, handwriting-adjacent content and layout better than classic OCR in general, but *no German-specific primary benchmark was found*.
- Cost example (Anthropic): native PDF input converts each page to text plus an image, at roughly 1,500-3,000 text tokens per page plus image tokens. Limits: 32 MB per request; 100 pages per request when the context window is under 1M tokens ([Claude PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support)). A 1-3 page letter is cheap.
- Bring-your-own-LLM caveat: not every configured model accepts images, and local OpenAI-compatible servers need a VLM loaded (e.g. a Qwen-VL class model, which needs a GPU for reasonable speed). The pipeline must detect "no vision" and fall back to OCR.
- Privacy: this sends the full letter image to the LLM endpoint. That is the same trust boundary as sending the extracted text, but images can carry more (signatures, letterheads with children's names).

## Implications for Family Agenda

**Recommendation.**
1. **Mailbox Source = IMAP, one folder, read-only.** Use a generic IMAP adapter (`EXAMINE` + `BODY.PEEK`, track `UIDVALIDITY`/`UID`, poll every 2-5 minutes, IDLE optional). Recommend in the setup guide that the Admin either (a) creates a dedicated "Family Agenda" mailbox and forwards to it, or (b) creates a provider-side filter into a dedicated folder/label. Gmail goes over IMAP with an app password. Do not build a Gmail API adapter for v1: restricted-scope verification and 7-day Testing tokens make it worse than IMAP for one Family. Outlook.com would need OAuth (XOAUTH2), so defer it unless a Family needs it.
2. **Selection** = folder/label first, then a sender/subject allow-list in the Source config, then an LLM relevance check feeding the Admin review. Never ingest the whole inbox.
3. **PDF pipeline** = per page: text layer via pypdf or pypdfium2 (permissive licences; avoid PyMuPDF's AGPL unless needed). If the page has no meaningful text, rasterise it with pypdfium2 and **send the image to the configured LLM if it supports vision**. Otherwise **fall back to Tesseract `deu` via OCRmyPDF** (CPU-only, Apache/MPL, small). Keep Docling as a later option if layout/tables matter. Skip Marker/Surya and olmOCR for v1: they need a GPU, and Marker's weights carry a non-OSI licence.
4. **Validate before committing:** collect 10-20 real (redacted) school letters and compare Tesseract `deu` with vision-LLM transcription on dates, times and things to bring. Those fields drive **Events**, **Tasks** and **Deadlines**.
