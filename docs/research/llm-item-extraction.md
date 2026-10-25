# LLM extraction of Items from German school mail and PDFs

Research for [issue #6](https://github.com/artkoenig/family-buttler/issues/6). Date: 2026-10-25.
Terms (Item, Event, Timetable Change, Task, Deadline, Notice, Family Member, Admin, Source) follow [GLOSSARY.md](../../GLOSSARY.md). "Review Inbox" means the Admin's review of uncertain Items.

**Question:** If the Family brings its own OpenAI-compatible endpoint (local or BYOK), how reliably can it turn German school mail and PDFs into typed Items, and how do we know when it is unsure?

**Short answer:** Getting JSON that matches the schema is solved on every serious runtime. Getting the *content* right is a model and prompt problem, and it mostly fails on dates and on which Family Member an Item concerns. "OpenAI-compatible" does not mean every feature works the same: Anthropic's compat layer ignores `response_format` and `logprobs`. Plan for a small provider-adapter layer, deterministic date resolution and Family Member mapping, and a Review Inbox that runs on validation rules, not on model-reported confidence.

> Note on sourcing: from this research environment only GitHub and Anthropic's docs could be fetched directly. Runtime claims are verified against docs or source code in the projects' GitHub repos. Claims about OpenAI, Mistral, LM Studio and Gemma come from their doc pages as surfaced by search and are marked *(via search)*. Verify those before implementing.

---

## 1. Structured output / JSON schema support per runtime

| Runtime / provider | Schema-constrained output via OpenAI `/v1/chat/completions` | Notes |
|---|---|---|
| **Ollama** (local) | Yes: `response_format: {type: "json_schema", json_schema: {...}}` is parsed by the OpenAI layer ([openai.go](https://github.com/ollama/ollama/blob/main/openai/openai.go)). Native `/api/chat` takes the schema in `format` ([structured-outputs doc](https://github.com/ollama/ollama/blob/main/docs/capabilities/structured-outputs.mdx)). | The docs say "It is ideal to also pass the JSON schema as a string in the prompt to ground the model's response." **Ollama's cloud does not support structured outputs.** |
| **llama.cpp** `llama-server` | Yes: `response_format` `{type:"json_schema", json_schema:{schema}}` or `{type:"json_object", schema}`, compiled to a GBNF grammar ([server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [grammars README](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)). | Known gaps: nested `$ref` broken, `pattern` must be anchored `^…$`, no `patternProperties`, no `uri`/`email` formats. **"Unsupported features are skipped silently"**, so validate on the client side as well. `additionalProperties` defaults to `false`. |
| **vLLM** | Yes: `response_format` `json_schema` plus `regex`/`choice`/grammar; backends `xgrammar` and `guidance`, default `auto` ([structured_outputs.md](https://github.com/vllm-project/vllm/blob/main/docs/features/structured_outputs.md)). | `lm-format-enforcer` backend is deprecated. Switching backends can change regex behaviour. Overkill for one Family but works. |
| **LM Studio** | Yes: `response_format` `json_schema` on `/v1/chat/completions` *(via search: [lmstudio.ai/docs/developer/openai-compat/structured-output](https://lmstudio.ai/docs/developer/openai-compat/structured-output))*. | Reportedly supports only `json_schema`, not `json_object`. |
| **OpenAI** | Yes: `response_format` `json_schema` with `strict: true` ([openai-python helpers.md](https://github.com/openai/openai-python/blob/main/helpers.md)). | Strict mode needs `additionalProperties:false` and every field `required` (use nullable types for optional fields). |
| **Anthropic** | **No through the OpenAI layer:** `response_format` is "Ignored" and `strict` on tools is "Ignored" ([OpenAI SDK compatibility](https://platform.claude.com/docs/en/api/openai-sdk)). The native Messages API supports it (GA): `output_config.format: {type:"json_schema", schema}` ([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)). | Native limits: no `minLength`/`maxLength`, `minimum`/`maximum`, or recursive schemas; `additionalProperties` must be `false`; `date` and `date-time` formats **are** supported; enum casing is not guaranteed. On Claude 4.7 and later, `temperature` < 1 returns a 400 through the compat layer. |
| **Mistral** | Yes: `response_format` `json_schema` with an optional `strict` flag (defaults to false) *(via search: [AI SDK Mistral provider](https://ai-sdk.dev/providers/ai-sdk-providers/mistral))*. Document AI/OCR can return structured "annotations" from a JSON schema for whole PDFs *(via search: [docs.mistral.ai annotations](https://docs.mistral.ai/capabilities/document_ai/annotations))*. | |

**What follows:** "Any OpenAI-compatible endpoint" works only if the request stays within a common subset: flat-ish schema, internal `$defs` only, no numeric or length constraints, `additionalProperties:false`, all fields required and nullable. Anthropic needs a native adapter. Always validate the response client-side (e.g. Pydantic or Zod), because llama.cpp drops unsupported schema features silently and a `refusal` or `max_tokens` stop can return non-conforming JSON (Anthropic docs).

**Quality caveat:** constraining the decoder guarantees valid syntax, not correct content. Tam et al., [*Let Me Speak Freely?*](https://arxiv.org/abs/2408.02442) (EMNLP 2024 Industry), found that strict JSON-mode lowers reasoning performance. A 2026 preprint, [*The Constraint Tax*](https://arxiv.org/abs/2605.26128), reports the cost is largest for small (sub-3B) models. Our extraction is mostly classification and copying, which suffers least, but date arithmetic is reasoning. So keep date resolution out of the model (see §5), or let a thinking model reason before it emits the constrained JSON.

## 2. Local models for German extraction and their hardware

Current open families (verified in the vendors' GitHub repos as of Oct 2026):

- **Qwen**: Qwen3.5 (Feb–Mar 2026) comes in 0.8B/2B/4B/9B dense, 27B dense, 35B-A3B and 122B-A10B MoE, and 397B-A17B. It is natively vision-language ("outperforms Qwen3-VL") and covers 201 languages. Qwen3.6-27B/35B-A3B (Apr 2026) and Qwen3.8-27B (Aug 2026) followed ([QwenLM/Qwen3.5 README](https://github.com/QwenLM/Qwen3.5)). llama.cpp supports Qwen3.5 text and vision.
- **Gemma 4**: E2B, E4B, 26B-A4B (MoE) and 31B dense. All take vision input; E2B/E4B also take audio. Pre-quantised GGUFs are in the [llama.cpp multimodal list](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md). Gemma 4 is also the default vision model in [Ollama's vision doc](https://github.com/ollama/ollama/blob/main/docs/capabilities/vision.mdx). 140+ languages *(via search)*.
- **Mistral Small** (24B; 3.2 and Small 4 from Mar 2026) handles image and text input *(via search)*. It is a European model with good German output.

**German-specific evidence is thin.** There is no current German leaderboard that ranks these exact generations. The best recent data point is [MÖVE](https://arxiv.org/abs/2606.13111) (2026, German public-sector benchmark). Even the previous generation's Qwen3-4B and Qwen3-30B-A3B reached its German QA top 10. Language adherence was the issue for tiny models: Gemma2-2B answered in German only 42.1% of the time, while Mistral Small 3.1 was near-perfect. Our task returns English field names with copied German strings, so language adherence matters less than reading comprehension.

**Practical tiers.** VRAM numbers are estimates from the usual Q4_K_M rule of about 0.6 GB per billion parameters, plus 1–4 GB for KV cache at an 8–16k context. They are not measured:

| Tier | Example models | Approx. memory | Expectation for school mail |
|---|---|---|---|
| Minimal | Qwen3.5-4B, Gemma 4 E4B | 4–6 GB (CPU-only works, slowly) | Workable for clean, short mails. Misses implicit Tasks and mixes up multiple Items in one letter. Needs review of most output. |
| **Recommended local** | Qwen3.5-9B; Gemma 4 26B-A4B or Qwen3.5/3.6-35B-A3B (MoE, only 3–4B active, so fast even on CPU or Apple Silicon) | 8–12 GB (9B); 18–24 GB (MoE) | Good for typical Elternbriefe. MoE models fit a 24 GB GPU or a 32 GB Mac at usable speed. |
| Strong local | Qwen3.8-27B / Qwen3.6-27B, Gemma 4 31B, Mistral Small 24B | 16–22 GB | Close to BYOK quality on this kind of text. A single 24 GB GPU. |
| BYOK | any current frontier model | n/a | Best quality. Cost is negligible at one Family's volume. Raises privacy questions because children's school data leaves the house. |

Mail volume is tiny (tens per week), so latency hardly matters. A slow CPU run of a 9B or MoE model is acceptable if it happens in the background.

## 3. Vision for scanned PDFs and images

- Most school PDFs are born-digital. **Extract the text layer first** (e.g. `pdftotext`) and send text. That is cheaper and more reliable than vision, and it works on every endpoint.
- For scans and photos (e.g. a photographed Elternbrief or a WhatsApp image), use a vision model:
  - **Ollama**: `image_url` content parts on `/v1/chat/completions`. Only **base64** works, not remote image URLs ([openai-compatibility doc](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx)). Vision and `format` schemas can be combined (structured-outputs doc, "Vision with structured outputs").
  - **llama.cpp**: image input on `/chat/completions` via `--mmproj` (libmtmd). The docs warn that dedicated OCR models (PaddleOCR-VL, GLM-OCR, DeepSeek-OCR…) need their specific prompt format ([multimodal.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)).
  - **Anthropic compat**: `image_url` is supported, `file` (PDF) parts are **ignored**. Native PDF support exists only on the Messages API ([compat doc](https://platform.claude.com/docs/en/api/openai-sdk)).
  - **Mistral**: Document AI/OCR with schema annotations goes straight from PDF to JSON *(via search)*.
- Recommended pipeline: text layer → if empty, rasterise pages → a VLM (or classic OCR such as Tesseract `deu`) to transcribe → the *same* text extraction prompt. Two steps keep extraction prompts and evaluation identical across inputs, and allow a stronger OCR model with a weaker extractor.

## 4. A usable confidence signal for the Review Inbox

| Signal | Availability | Verdict |
|---|---|---|
| **Token logprobs** of key fields (date digits, Item type) | llama.cpp (`n_probs`, `completion_probabilities`), vLLM, Ollama (native API; the OpenAI layer also forwards `logprobs` in [source](https://github.com/ollama/ollama/blob/main/openai/openai.go), although its compat doc checklist still says unsupported), OpenAI non-reasoning models only. **Not** Anthropic ("Ignored"/"Always empty"), and not OpenAI reasoning models (400 `unsupported_parameter`, [forum report](https://community.openai.com/t/logprobs-deprecated-for-gpt-5-models/1355427)). | Not portable across BYOK, so it can only be an optional extra signal. |
| **Verbalised confidence** (a per-Item `confidence` field) | Everywhere | Cheap but weakly calibrated. [Tian et al. 2023](https://arxiv.org/abs/2305.14975) found it often beats logprobs for RLHF models. [Kim & Kang 2026](https://arxiv.org/abs/2605.27752) show that this advantage is fragile and depends on the protocol. Use it only as a tie-breaker. |
| **Deterministic validation rules** | Everywhere | **Primary signal.** Examples: year was inferred; resolved date is in the past or more than 9 months ahead; no Family Member could be mapped, or more than one; Task without a Deadline although the text has a date; Event without a time; evidence quote not found verbatim in the source; schema-repair retry was needed. |
| **Evidence span check** | Everywhere | Require an `evidence` field with a verbatim quote for each Item, and verify it is a substring of the source (after normalising whitespace). This catches hallucinated Items cheaply. |
| **Self-consistency** (run twice, or with two models, and compare) | Everywhere | Disagreement on type, date or Family Member is a strong review trigger. Affordable at family volume. |

Recommendation: route an Item to the Review Inbox when **any rule fires**, verbalised confidence is "low", or two runs disagree. Never rely on logprobs alone.

## 5. Common failure modes in German school mail

1. **Dates without a year** ("am Mittwoch, 12.11."; "nach den Herbstferien"). The model guesses the year, often wrongly near New Year or from its training-era prior. → Ask the model for **unresolved date parts** (`day`, `month`, `year|null`, `weekday|null`, verbatim text) and resolve them in code against the mail's `Date:` header. Cross-check weekday against date: if "Mittwoch, 12.11." is not a Wednesday in the inferred year, flag it.
2. **Relative dates** ("morgen", "nächste Woche Dienstag", "bis Ende der Woche", "in zwei Wochen"). The anchor is the send date, not the processing date. LLMs often mis-anchor, or read durations as dates ([Temporal Blind Spots](https://arxiv.org/abs/2401.12078); [omitted temporal expressions 2026](https://arxiv.org/abs/2609.09569)). → Put the send date and its weekday in the prompt, have the model return the relative expression verbatim, and resolve it deterministically. "Nächste Woche" is ambiguous in German as well, so flag it for review.
3. **School-calendar references** ("erster Schultag nach den Ferien", "Elternsprechtag"). These cannot be resolved without the state's holiday calendar. → Pass the known holiday dates (Bundesland) as context, or flag the Item.
4. **Multiple children and classes.** One Elternbrief can address "alle Klassen 5" or name several pupils. Mailing lists are per class, so the recipient address is often the best signal. → The model extracts *mentions* (class "5b", first name, school). Code maps them to Family Members through a configured roster. If nothing maps, or more than one Family Member matches, the Item goes to review. Do not ask the model to pick Family Member IDs.
5. **One mail, many Items** (a newsletter containing an Event, a Task with things to bring, and a Notice). Small models merge or drop Items. → The schema is an `items: []` array with a discriminated `type`. The prompt should explicitly say "extract every Item". MoE or ≥9B models do noticeably better here.
6. **Task vs Event vs Notice ambiguity** ("Am Freitag ist Wandertag, bitte Brotdose und Regenjacke mitgeben"). This is one Event plus one Task with items to bring and a Deadline equal to the Event date. → Put explicit few-shot examples in German into the prompt.
7. **Timetable Changes from mail.** Rare (Untis is the authoritative Source), but "Die 5. und 6. Stunde entfallen am Donnerstag" needs period-to-time mapping. → Extract the periods and map them through the Timetable in code.
8. **Boilerplate and quoted replies** (signatures, legal footers, `>` quoted threads) produce duplicate Items. → Strip them before extraction and deduplicate by (type, date, normalised title).
9. **Silent schema degradation.** llama.cpp skips unsupported schema features, and a `max_tokens` cut leaves partial JSON. → Validate, repair once, then send to review.

---

## Implications for Family Butler

- **Recommendation: build extraction behind a thin `Extractor` adapter with two implementations: OpenAI-compatible chat (Ollama, llama.cpp, vLLM, LM Studio, OpenAI, Mistral) and native Anthropic.** Use one portable JSON schema (flat, all fields required and nullable, `additionalProperties:false`, internal `$defs` only) and validate every response client-side.
- **Keep the LLM to reading, and do the reasoning in code.** The model returns Item type, title, verbatim date/time *mentions*, things to bring, Family Member *mentions* and an evidence quote. Deterministic code resolves dates against the mail's send date and the Bundesland holidays, and maps mentions to Family Members via a roster. This removes the two biggest failure modes from the model's hands and makes small local models viable.
- **Review Inbox runs on rules, not on model confidence:** inferred year, unresolved relative date, no or several Family Members, evidence not found, weekday/date mismatch, repair needed, low verbalised confidence, or disagreement between two runs.
- **Default local model to recommend:** a 9B dense or ~30B-class MoE (Qwen3.5-9B; Gemma 4 26B-A4B or Qwen3.5/3.6-35B-A3B) on 12–24 GB. Treat 4B-class as "works, but expect a busy Review Inbox". A frontier BYOK model is the quality ceiling, with a clear privacy note for the Admin.
- **PDFs:** text layer first; use vision or OCR only for scans. Never depend on sending raw PDFs through an OpenAI-compatible layer (Anthropic ignores `file` parts; Ollama takes images as base64 only).
- **Before committing to a model tier, build a small German fixture set** (20–40 real, anonymised Elternbriefe with expected Items) and measure per-field accuracy. Published benchmarks do not answer this question for our document type.
