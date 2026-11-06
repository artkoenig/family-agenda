# LLM cost per Family on an EU-hosted endpoint

Research for [issue #214](https://github.com/artkoenig/family-agenda/issues/214), part of map [#222](https://github.com/artkoenig/family-agenda/issues/222) (Paid hosted Family Agenda). Date: 2026-11-06.
Terms follow [GLOSSARY.md](../../GLOSSARY.md). Extraction quality and runtimes are in [llm-item-extraction.md](llm-item-extraction.md).

**Question:** What does the hosted LLM endpoint cost per Family per month at low / typical / heavy volume, which EU providers with an OpenAI-compatible API could serve it, do they offer a DPA, and where does a fair-use cap sit?

**Short answer:** The token cost is small enough to be a rounding error in the price. On a 24B-class model such as Mistral Small 3.2, one Family costs roughly **EUR 0.01 (low), 0.06 (typical) and 0.40 (heavy) per month**. Even a reasoning model at a larger size stays under EUR 1.50 at heavy volume. The price floor is therefore set by other Agenda Cloud costs, not by the LLM. A fair-use cap of about **2.5 million input tokens per month** (about 800 messages) would cost at most about EUR 0.50 on the recommended model and still covers the heavy case.

> **Sourcing caveat, read first.** From this research environment the provider hosts (`mistral.ai`, `scaleway.com`, `ovhcloud.com`, and their docs and DPA pages) could not be fetched: they are outside the session's allowed network domains. Only the token volumes (section 1) are verified against the repository. **Every price and every DPA statement below is unverified**: prices come from search-engine extracts of the providers' pages and from third-party aggregators, and the DPA column is empty where search returned nothing. Before the price is decided, someone must open each provider's pricing page and DPA and check the cells marked *(unverified)*. The cost model in section 3 is parametric, so only the price inputs need replacing.

---

## 1. Token volume per message (from the code)

Source of truth: `packages/application/src/extraction.ts` and `packages/adapters/src/openai-compatible-extractor.ts`.

What one extraction read sends and receives:

| Part | Size | Basis |
|---|---|---|
| System instructions | about 650 tokens | The `instructions` constant is 2,543 characters (475 words); at roughly 4 characters per token for English prose. |
| JSON schema (`response_format`, `strict: true`) | about 450 tokens | `extractionSchema` is about 1,800 characters of JSON. Providers differ in whether they count it as input; counted here to stay on the safe side. |
| Send-date line and `<<< >>>` wrapper | about 40 tokens | `promptOf`. |
| **Fixed overhead per read** | **about 1,100 tokens** | Sum of the above. |
| Message text | variable | The mail body followed by the text of its PDF attachments (`fullTextOf`). German text is assumed at about 3 to 3.5 characters per token. |
| Output | 15 tokens for a message with nothing in it, about 120 tokens per Item | Each Event or Task is a JSON object with a six-field date mention and a verbatim `evidence` quote. |

Facts about the pipeline that bound the volume:

- **One chat completion per message, once** (ADR-0016). Items are written once or not at all. There is no re-extraction on a schedule.
- **A second read happens only when an Item fails an automatic check** (`extractOne`: `checkAll`, then `read` again). So retries multiply cost only for messages with a failing Item; assumed 10 to 25 percent of messages.
- **At most 20 messages per run** (`batchSize`), a pacing limit and not a cost cap.
- **Only text reaches the LLM endpoint.** PDF text layers are read locally by the `TextExtractor`, and scanned pages are read by **Tesseract OCR on the Instance** (`readScans`, at most 10 scanned pages per attachment). No images are sent, so no image tokens are billed, and the hosted endpoint does not need a vision model.
- There is **no truncation of message text** before it is sent. A very long newsletter or a 20-page PDF with a text layer goes in whole, so the heavy case is dominated by a few long messages. A cap on message length or on tokens per month belongs in the hosted service.
- Messengers are out of scope for the hosted plan (per the ticket), so the volume is mail, calendar-derived text and PDF attachments.
- The adapter sends `reasoning_effort: "low"`. A reasoning model still adds hidden output tokens; the model below allows for about 500 per read as a sensitivity, and none for a non-reasoning model.

### Monthly volume per Family

These are assumptions for a family with school-age children, not measurements; nothing in the repo records real volumes. Fixture-based measurement is the follow-up (section 5).

| Scenario | Messages per month | Average text per message | Retry share | Reads | Input tokens | Output tokens |
|---|---|---|---|---|---|---|
| Low | 40 (one child, one class list, no PDFs) | 600 tokens (about 2,000 characters) | 10% | 44 | about 75,000 | about 4,000 |
| Typical | 150 (two children, class and school lists, some PDFs) | 1,000 tokens | 15% | 172 | about 362,000 | about 26,000 |
| Heavy | 600 (three children, several newsletters, many PDF letters) | 2,000 tokens | 25% | 750 | about 2,325,000 | about 188,000 |

Input per read is the fixed 1,100 tokens plus the average text. Output per read is 100 / 150 / 250 tokens.

## 2. EU-hosted providers with an OpenAI-compatible API

All prices below are **unverified** (see the caveat) and are per million tokens, before tax.

| Provider | Hosting | OpenAI-compatible | Candidate model | Input / output | DPA |
|---|---|---|---|---|---|
| **Scaleway** Generative APIs (France) | Search extracts say EU data centres (Paris and others); not verified on a primary page. | Yes, the product is marketed as "OpenAI-compatible APIs" ([search result](https://www.scaleway.com/generative-apis/)). | `mistral-small-3.2-24b-instruct-2506` | EUR 0.15 / 0.35 *(unverified, via search of [scaleway.com/generative-apis](https://www.scaleway.com/generative-apis/))* | Not found. *(unverified)* |
| | | | `gpt-oss-120b` | EUR 0.15 / 0.60 *(unverified)* | |
| | | | `qwen3.6-35b-a3b` | EUR 0.25 / 1.50 *(unverified)* | |
| | | | `qwen3.5-397b-a17b` | EUR 0.60 / 3.60 *(unverified)* | |
| **Mistral** La Plateforme (France) | Not verified which region serves the API by default. | Chat completions endpoint with `json_schema` response format (see llm-item-extraction.md, via search). | Mistral Small (3.2 / 4) | USD 0.15 to 0.20 input, 0.60 output; sources disagree, one aggregator even lists USD 0.10 / 0.30 *(unverified, aggregators only)* | Not found. *(unverified)* |
| **OVHcloud** AI Endpoints (France) | Search extract: runs on OVHcloud's own infrastructure in European data centres *(unverified)*. | Not confirmed on a primary page. | Mistral Small 3.2, Qwen3 family, gpt-oss | About USD 0.09 / 0.28 for Mistral Small 3.2 *(third-party calculator, unverified)* | Not found. *(unverified)* |
| **IONOS** AI Model Hub, **STACKIT** AI Model Serving (both Germany) | Not researched: hosts not reachable and not searched. | Not checked. | n/a | n/a | n/a |

Observations that hold even with unverified numbers:

- Every candidate lists models good enough for this task (the earlier research puts a 9B dense or 30B-class MoE model as sufficient for typical Elternbriefe; Mistral Small 24B is in its "strong local" tier) at **well under EUR 1 per million input tokens**.
- Because only text is sent, the cheapest suitable tier is a 24B to 35B text model. A 397B model is not needed and is shown below only as an upper bound.
- Scaleway advertises a free first million tokens for new customers *(unverified)*; irrelevant for a production price.
- **DPA and sub-processors are the open question.** A paid hosted service that forwards children's school data must have a processor agreement with the LLM provider (GDPR Art. 28) and must name that provider as a sub-processor towards the Families. None was confirmed from a primary source. Each provider's legal documentation (DPA, sub-processor list, data location, retention and training-on-data policy) needs to be read directly before a provider is chosen.

## 3. Resulting cost per Family per month

Computed from the volumes in section 1 and the unverified prices in section 2 (`cost = input / 1M * price_in + (output + hidden reasoning) / 1M * price_out`). Reasoning models get +500 hidden output tokens per read; Mistral Small 3.2 is not a reasoning model.

| Model (Scaleway list price, unverified) | Low | Typical | Heavy |
|---|---|---|---|
| Mistral Small 3.2 24B (0.15 / 0.35) | EUR 0.01 | EUR 0.06 | EUR 0.41 |
| gpt-oss-120b, with reasoning (0.15 / 0.60) | EUR 0.03 | EUR 0.12 | EUR 0.69 |
| Qwen3.6-35B-A3B, with reasoning (0.25 / 1.50) | EUR 0.06 | EUR 0.26 | EUR 1.43 |
| Qwen3.5-397B-A17B, with reasoning (0.60 / 3.60), upper bound | EUR 0.14 | EUR 0.62 | EUR 3.42 |

Sensitivities:

- **Prices off by a factor of two** (the aggregators disagree by about that much): the typical figure stays under EUR 0.15 on the 24B model. The conclusion does not change.
- **Prompt caching** is not assumed. The 1,100-token fixed prefix is identical for every read, so a provider with prefix caching would cut the typical input cost by about a third; none of the candidates was verified to offer it.
- **Batch discount** (Scaleway advertises one for non-realtime use, *unverified*) fits the worker, which already runs extraction in the background, but is not needed.
- Output is a small share of the bill except for reasoning models; a hard cap on `max_tokens` is cheap insurance against a runaway reasoning model.

## 4. Where the fair-use cap sits

The cap exists to stop an abusive or broken Source (a mailing list flooding the mailbox, a loop of retries), not to ration normal use.

- **Normal use costs a fraction of one euro.** Typical is below EUR 0.30 on every model in the table except the 397B upper bound.
- **Suggested cap: about 2.5 million input tokens and 250,000 output tokens per Family per month.** That is just above the heavy scenario, and costs at most about EUR 0.45 on Mistral Small 3.2 and about EUR 0.80 on gpt-oss-120b (both unverified list prices). Expressed in messages that is roughly 800 average messages.
- **Meter tokens, not messages.** One message can be a 30-page PDF. The adapter already sees `finish_reason` and the endpoint's `usage` object; the hosted endpoint can count there.
- **Behaviour at the cap:** the extraction already leaves messages pending when the endpoint refuses (`extractPending`: the rest wait for the next run). A cap can therefore be a soft pause until the next period, with the Admin shown how many messages wait, with no data loss.
- **Add a per-message limit** (for example 20,000 tokens of text) so a single oversized attachment cannot use the whole allowance. Today nothing truncates a message, so this would be new work in the extraction.

## 5. Consequences for the decision this unblocks

- **Price floor:** the LLM contributes cents per month to cost of goods. It does not justify a price tier; the floor is set by Remote Access, push delivery, backups and operations.
- **Fair-use limit:** use the token cap above, tuned after the fixture measurement below.
- **Provider choice is a legal question first, a price question second.** All candidates are within a few euro cents of each other at typical volume.

## 6. Open items before this ticket is fully closed

1. Allow the provider hosts in the research session (or check by hand) and replace every *(unverified)* cell: the official pricing pages of Scaleway, Mistral, OVHcloud, IONOS and STACKIT; each provider's DPA, sub-processor list, data location and no-training commitment.
2. Confirm which of them ship an OpenAI-compatible `/chat/completions` with `json_schema` strict output for the chosen model; the adapter depends on it (llm-item-extraction.md section 1).
3. Replace the assumed volumes with measurements: run the 20 to 40 anonymised German fixtures proposed in llm-item-extraction.md through the adapter and read `usage` for real input and output tokens per message, with and without PDFs.
4. Decide whether the hosted endpoint will be a reasoning model; that is the single biggest cost lever (section 3).
