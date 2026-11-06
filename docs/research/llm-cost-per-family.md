# LLM cost per Family on an EU-hosted endpoint

Research for [issue #214](https://github.com/artkoenig/family-agenda/issues/214), part of map [#222](https://github.com/artkoenig/family-agenda/issues/222) (Paid hosted Family Agenda). Date: 2026-11-06 (second pass, with provider pages read directly).
Terms follow [GLOSSARY.md](../../GLOSSARY.md). Extraction quality and runtimes are in [llm-item-extraction.md](llm-item-extraction.md).

**Question:** What does the hosted LLM endpoint cost per Family per month at low / typical / heavy volume, which EU providers with an OpenAI-compatible API could serve it, do they offer a DPA, and where does a fair-use cap sit?

**Short answer:** The LLM does not set the price floor. On a 24B-class model the token cost is about **EUR 0.01 (low), 0.05 (typical) and 0.26 (heavy) per Family per month**; the most expensive sensible choice (a 27B to 35B reasoning model) is about EUR 0.2 typical and EUR 1.0 to 1.8 heavy. A fair-use cap of **2.5 million input and 300,000 output tokens per month** costs at most about EUR 0.5 on the shortlisted models. Shortlist: **Scaleway Generative APIs** with `mistral-small-3.2-24b-instruct-2506` (everything we need is documented on primary pages), and **IONOS AI Model Hub** as the strongest privacy option, pending a `json_schema` test.

## What is verified and what is not

| Item | Status |
|---|---|
| Token overhead per read (instructions, schema, wrapper) | Measured with three tokenizers against the repo's real prompt and schema. |
| Token volume of message text and output | **Measured on 24 synthetic German fixtures** with real tokenizers. The fixtures are written by me, not real mails: they fix tokens-per-character and output size per Item, but **messages per month and the share of newsletters and PDFs stay assumptions**. No provider key was available, so no real `usage` numbers. |
| List prices of Scaleway, OVHcloud, IONOS, STACKIT, Mistral | Read on the providers' own pages on 2026-11-06 (links below). |
| `json_schema` structured output | Verified for Scaleway and OVHcloud (own pages) and Mistral (own docs). **Not verified for IONOS and STACKIT**: neither page I read mentions it. |
| Data location, retention, training | Verified for Scaleway, IONOS, OVHcloud (partly), STACKIT (partly), Mistral (partly); see section 2. |
| DPA | Text read for Scaleway and Mistral. IONOS states one applies and links it, not opened. **OVHcloud and STACKIT DPA not located.** |
| Sub-processor lists | Mistral's list is a JavaScript page that did not render; Scaleway's is referenced in the DPA but not opened; IONOS states none are engaged. |

## 1. Token volume per message

### Fixed overhead per read (measured)

Source of truth: `packages/adapters/src/openai-compatible-extractor.ts` (the `instructions` constant, `extractionSchema`, `promptOf`) and `packages/application/src/extraction.ts`. The schema was counted as the `response_format` JSON that the adapter sends with `strict: true`; providers that inject it into the prompt count it as input.

| Tokenizer | Instructions | Schema | Wrapper | Fixed per read |
|---|---|---|---|---|
| o200k (OpenAI; gpt-oss models) | 635 | 410 | 27 | **1,072** |
| Mistral Small 24B (HF `Mistral-Small-24B-Instruct-2501`) | 651 | 455 | 35 | **1,141** |
| Qwen3 (HF `Qwen/Qwen3-8B`) | 644 | 399 | 33 | **1,076** |

This matches the 1,100 tokens assumed in the first pass. Chat-template tokens (a handful) are not counted.

### Message text and output (measured on synthetic fixtures)

24 German messages in four kinds: 8 short notes, 8 medium mails, 4 long newsletters (with the usual legal footer) and 4 PDF letters (mail body plus `Attachment <name>:` text, as `fullTextOf` builds it). Each has an expected Item list rendered into the real output schema, so output tokens are those of valid answers. Mean text tokens per message, by tokenizer:

| Kind | o200k | Mistral Small | Qwen3 | Output tokens (Mistral) | Characters per token (Mistral) |
|---|---|---|---|---|---|
| Short note | 37 | 44 | 46 | 88 | 3.2 |
| Medium mail | 246 | 287 | 314 | 179 | 3.6 |
| Newsletter | 1,243 | 1,409 | 1,556 | 493 | 3.8 |
| PDF letter | 1,002 | 1,140 | 1,253 | 378 | 3.8 |

German costs about 3.2 to 3.8 characters per token on the Mistral tokenizer and 3.0 to 3.4 on Qwen3; the first pass assumed 3 to 3.5. Output is about 70 to 90 tokens per Item plus a small constant.

My short and medium fixtures are probably shorter than real school mail (real mails carry quoted threads, signatures and footers), so the cost table also shows a **doubled message text** sensitivity.

### Facts about the pipeline that bound the volume (unchanged)

- One chat completion per message (ADR-0016). A second read happens only when an Item fails an automatic check (`extractOne`); retries are assumed at 10, 15 and 25 percent of messages for low, typical and heavy.
- At most 20 messages per run (`batchSize`): pacing, not a cap.
- Only text reaches the LLM. PDF text layers and Tesseract OCR run on the Instance (`readScans`, at most 10 scanned pages per attachment), so no image tokens are billed and no vision model is needed.
- Nothing truncates message text before it is sent, so a few very long messages dominate the heavy case.
- The adapter sends `reasoning_effort: "low"`; a reasoning model still adds hidden output tokens. The cost table shows models without and with 400 hidden tokens per read.

### Monthly volume per Family (message counts are assumptions)

| Scenario | Messages (short / medium / newsletter / PDF letter) | Retry share | Reads | Input tokens | Output tokens |
|---|---|---|---|---|---|
| Low | 40 (20 / 16 / 4 / 0) | 10% | 44 | about 62,000 | about 7,000 |
| Typical | 150 (60 / 50 / 25 / 15) | 15% | 172 | about 277,000 | about 37,000 |
| Heavy | 600 (200 / 190 / 120 / 90) | 25% | 750 | about 1,275,000 | about 181,000 |

(Mistral tokenizer; the others are within 8 percent.) The first pass assumed more input at typical and heavy (362k and 2.3M); measuring shows message text is smaller than I guessed, while output is larger, because each Item carries a six-field date mention and a verbatim evidence quote.

## 2. EU-hosted providers with an OpenAI-compatible API

All pages read on 2026-11-06. Prices are per million tokens, before tax, for a model suitable for extraction (the earlier research puts a 9B dense or 30B-class model as sufficient for typical Elternbriefe).

### Scaleway Generative APIs (France)

- **Prices:** `mistral-small-3.2-24b-instruct-2506` EUR 0.15 / 0.35; `gpt-oss-120b` EUR 0.15 / 0.60; `qwen3.6-35b-a3b` EUR 0.25 / 1.50; `gemma-4-26b-a4b-it` EUR 0.25 / 0.50. Batch API at minus 50 percent; the first 1,000,000 tokens are free ([pricing](https://www.scaleway.com/en/pricing/model-as-a-service/)).
- **Structured output:** `response_format: {"type": "json_schema"}` with nested schemas, `$ref`, `anyOf` and regular expressions; "All LLMs in the Scaleway library support Structured outputs" ([docs](https://www.scaleway.com/en/docs/generative-apis/how-to/use-structured-outputs/)). OpenAI libraries work ([FAQ](https://www.scaleway.com/en/docs/generative-apis/faq/)).
- **Location:** serverless models are hosted in a data center in Paris operated by OPCORE; Scaleway "will continue to guarantee" they stay hosted in Europe ([FAQ](https://www.scaleway.com/en/docs/generative-apis/faq/)). Data region: Paris ([data privacy](https://www.scaleway.com/en/docs/generative-apis/reference-content/data-privacy/)).
- **Retention and training:** default Zero Data Retention policy; prompts and outputs are not collected, read or used, except for abusive or error-triggering requests, which may be stored up to two weeks; not used for training; usage metadata aggregated and kept up to 6 months; "not subject to extraterritorial laws such as the American Cloud Act" ([data privacy](https://www.scaleway.com/en/docs/generative-apis/reference-content/data-privacy/)).
- **DPA:** [Data Processing Agreement, version of 1 June 2024](https://www-uploads.scaleway.com/DPA_2024_ENG_b0abb5cc26.pdf), "an integral part of the contract", Scaleway as processor or sub-processor. Article 7.3 says the sub-processor list is available on Scaleway's website and Article 7.4 gives 30 days' notice of changes to those who subscribe to updates. The list itself was not opened.

### IONOS AI Model Hub (Germany)

- **Prices (USD):** Mistral Small 24B Instruct 0.11 / 0.33; Qwen3.5-9B 0.11 / 0.17; Qwen3.8-27B 0.45 / 2.70; gpt-oss-120b 0.17 / 0.71 ([pricing](https://cloud.ionos.com/managed/ai-model-hub)). The page lists dollars, not euros, so the euro cost depends on the invoice currency.
- **OpenAI compatibility:** "OpenAI-compatible REST API" ([same page](https://cloud.ionos.com/managed/ai-model-hub)). **`json_schema` support not found** in the product page, the models page or the text-generation how-to.
- **Location and retention:** all inference in IONOS data centers in Germany; prompts and outputs are never logged, never written to persistent storage, never used for training and not disclosed to third parties; operational access only from within the EU ([data handling](https://docs.ionos.com/cloud/ai/ai-model-hub/governance-and-compliance/data-handling)).
- **Sub-processors:** "No third-party sub-processors are engaged for AI Model Hub" (same page).
- **DPA:** the same page states a data processing agreement (Art. 28 GDPR) applies as part of the contract and links it; I did not open the document.

### OVHcloud AI Endpoints (France)

- **Prices (EUR):** Qwen3.5-9B 0.10 / 0.15; gpt-oss-20b 0.04 / 0.15; gpt-oss-120b 0.08 / 0.40; Qwen3.6-27B 0.40 / 2.70; Qwen3.8-27B 0.40 / 2.70 ([catalog](https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/)). **Mistral-Small-3.2-24B is marked "Retired on Nov 4, 2026"** there. Batch mode saves 50 percent; base mode SLA 99.5 percent ([product page](https://www.ovhcloud.com/en/public-cloud/ai-endpoints/)).
- **Structured output:** the catalog tags these models "Structured Output" and the Qwen3.5-9B page lists `json_object` and `json_schema`. OpenAI-compatible API ([product page](https://www.ovhcloud.com/en/public-cloud/ai-endpoints/)).
- **Location and retention:** "hosted and run in the European Union. Your data is never used to train our models, and we only keep what is strictly necessary for billing" (product page).
- **DPA:** **not located** on the pages I read; OVHcloud's contract list did not show an obvious DPA for this product. Needs a direct request.

### STACKIT AI Model Serving (Germany)

- **Prices (EUR):** gpt-oss-20b 0.15 / 0.25; Qwen3.6 27B and Qwen3.8 27B 0.45 / 0.65; gpt-oss-120b 0.45 / 0.65; Gemma 4 31B 0.45 / 0.65 ([price table](https://stackit.com/en/products/data-ai/stackit-ai-model-serving)).
- **OpenAI compatibility:** "provides an OpenAI-compatible API", region `eu01` ([docs](https://docs.stackit.cloud/products/data-and-ai/ai-model-serving/how-tos/use-the-models/)). **`json_schema` support not found** in the docs I read.
- **Retention:** "STACKIT does not collect or evaluate any customer data other than billing-relevant data"; customer data is not stored permanently; e-mail and subject ID are kept 30 days in service logs ([service certificate v1.4](https://stackit.com/en/asset/download/61500/file/Service_Certificate_STACKIT_AI_Model_Serving_1-4.pdf?version=10)). The certificate calls it a "GDPR-compliant service" but I found no DPA and no statement of the country of the data center for this service.

### Mistral AI, La Plateforme (France)

- **Price:** Mistral Small 4 USD 0.15 / 0.60 ([model page](https://docs.mistral.ai/models/mistral-small-4-0-26-03)). The pricing page quotes Mistral Large as the example, and notes batch at minus 50 percent and cached input up to minus 90 percent ([pricing](https://mistral.ai/pricing)).
- **Structured output:** custom JSON-schema outputs and JSON mode ([docs](https://docs.mistral.ai/inference/conversations/structured-output)).
- **DPA:** yes, [Data Processing Addendum](https://legal.mistral.ai/terms/data-processing-addendum) with Mistral as processor, an Exhibit listing a Paris address, sub-processors on its Trust Center, and SCCs for transfers.
- **Not EU-only:** the [privacy policy](https://legal.mistral.ai/terms/privacy-policy) says Mistral "prioritize[s]" EU providers but may use non-EU ones "in exceptional cases". Inputs and outputs are kept 30 rolling days for abuse monitoring unless zero data retention is activated, and the DPA lets Mistral train on Personal Data as controller unless the customer opted out. I found no commitment to process API traffic only in the EU.

## 3. Resulting cost per Family per month

`cost = input / 1M * price_in + output / 1M * price_out`, with each model's own tokenizer. "Base" has no hidden reasoning tokens; "+reasoning" adds 400 hidden output tokens per read for models that reason (gpt-oss, Qwen). Mistral Small 3.2 and IONOS's Mistral Small do not reason. Currency as listed by the provider.

| Model (provider) | Low | Typical | Heavy | Heavy, double text |
|---|---|---|---|---|
| Mistral Small 3.2 24B (Scaleway), EUR | 0.012 | 0.054 | 0.26 | 0.32 |
| gpt-oss-120b (Scaleway), EUR | 0.012 / 0.023 | 0.058 / 0.10 | 0.27 / 0.45 | 0.33 / 0.51 |
| Qwen3.6-35B-A3B (Scaleway), EUR | 0.025 / 0.052 | 0.12 / 0.23 | 0.58 / 1.03 | 0.69 / 1.14 |
| Qwen3.5-9B (OVHcloud), EUR | 0.007 / 0.010 | 0.033 / 0.043 | 0.15 / 0.20 | 0.20 / 0.24 |
| gpt-oss-20b (OVHcloud), EUR | 0.003 / 0.006 | 0.015 / 0.025 | 0.07 / 0.12 | 0.09 / 0.13 |
| gpt-oss-120b (OVHcloud), EUR | 0.007 / 0.014 | 0.033 / 0.061 | 0.16 / 0.28 | 0.19 / 0.31 |
| Qwen3.6-27B (OVHcloud), EUR | 0.043 / 0.09 | 0.20 / 0.39 | 0.97 / 1.78 | 1.16 / 1.97 |
| Mistral Small 24B (IONOS), USD | 0.009 | 0.043 | 0.20 | 0.25 |
| Qwen3.5-9B (IONOS), USD | 0.008 / 0.011 | 0.036 / 0.048 | 0.17 / 0.22 | 0.22 / 0.27 |
| gpt-oss-20b (STACKIT), EUR | 0.010 / 0.015 | 0.046 / 0.064 | 0.22 / 0.29 | 0.27 / 0.35 |
| Qwen3.6-27B (STACKIT), EUR | 0.032 / 0.043 | 0.15 / 0.19 | 0.68 / 0.88 | 0.89 / 1.09 |
| Mistral Small 4 (Mistral), USD | 0.014 | 0.064 | 0.30 | 0.36 |

Changes against the first pass: heavy on the 24B model fell from EUR 0.41 to 0.26 (measured text is shorter), the 24B typical figure fell from 0.063 to 0.054, and the previously unknown cheaper tiers (OVHcloud 9B and 20B models, IONOS) are now priced: **a Family costs a few cents a month at typical volume on every candidate, and under EUR 2 at heavy volume on the most expensive combination listed.** The 397B model shown before as an upper bound is no longer needed.

Sensitivities: prices off by a factor of two do not change the conclusion; prompt caching is not assumed, although the 1,100-token prefix is identical for every read (Scaleway and Mistral advertise cached-input pricing on some models, not verified for these); batch pricing at minus 50 percent (Scaleway, OVHcloud, Mistral) suits the background worker if latency does not matter.

## 4. Where the fair-use cap sits

The cap exists to stop an abusive or broken Source (a mailing list flooding the mailbox, a retry loop), not to ration normal use.

- **Suggested cap: 2.5 million input and 300,000 output tokens per Family per month.** Heavy needs 1.3M and 0.18M; the double-text sensitivity needs about 1.9M input. At the cap the bill is about **EUR 0.5** on Scaleway Mistral Small 3.2 (2.5 * 0.15 + 0.3 * 0.35) and about EUR 0.3 on OVHcloud gpt-oss-120b, plus up to about EUR 0.25 of hidden reasoning tokens on a reasoning model.
- **Meter tokens, not messages.** One message can be a 30-page PDF. The chat completion's `usage` object gives the count.
- **Behaviour at the cap:** extraction already leaves messages pending when the endpoint refuses (`extractPending`), so a cap can be a soft pause until the next period with no data loss; show the Admin how many messages wait.
- **Add a per-message limit** (for example 20,000 tokens of text): nothing truncates a message today, so this is new work in the extraction.
- **Set `max_tokens`** on the request as insurance against a runaway reasoning model; Scaleway's FAQ notes that several models can enter infinite generation loops, which means uncontrolled billing (the passage may be about its dedicated deployments; it applies to any per-token endpoint).

## 5. Shortlist and consequences for the decisions this unblocks

- **Price floor:** the LLM contributes cents per month. It is not a pricing tier; the floor is set by Remote Access, push, backups and operations. The claim holds with measured overhead and verified prices.
- **Shortlist 1, Scaleway with `mistral-small-3.2-24b-instruct-2506`:** the only candidate where price in euros, `json_schema` for all models, a Paris data location, a zero-data-retention default, a no-training statement and a readable DPA are all on primary pages. A non-reasoning model keeps the cost per read predictable. Open: open the sub-processor list; the "France only for now, Europe later" wording means the data location can widen within Europe.
- **Shortlist 2, IONOS AI Model Hub:** the strongest privacy statement (Germany only, nothing logged, no sub-processors, Art. 28 DPA stated) and comparable prices, but billed in USD and **`json_schema` is unverified**. Run the adapter against it before choosing.
- **OVHcloud** is cheapest and supports `json_schema`, but retired Mistral Small 3.2 on 4 November 2026, its remaining small models are reasoning models, and I found no DPA. **STACKIT** is documented as GDPR compliant, but I found no DPA, no `json_schema` statement and a higher price. **Mistral itself** has a DPA but does not promise EU-only processing of API traffic, keeps inputs 30 days by default, and its default terms allow training unless opted out.

## 6. Still unverified

1. Real `usage` from a provider: no API key was available, so volumes rest on tokenizer counts of 24 synthetic fixtures. Replace the fixtures with 20 to 40 anonymised real messages and read `usage` from a real endpoint, with and without PDF attachments.
2. Messages per month per Family (the mix in section 1) are assumptions; nothing in the repo records real volumes.
3. `json_schema` strict support on IONOS and STACKIT; the DPA of OVHcloud and STACKIT; Scaleway's sub-processor list; Mistral's sub-processor list (the page does not render without JavaScript) and its EU data location.
4. Whether any provider caches the identical 1,100-token prefix at a discount for these models.
5. Hidden reasoning tokens for gpt-oss and Qwen at `reasoning_effort: "low"` (400 per read is a placeholder).
