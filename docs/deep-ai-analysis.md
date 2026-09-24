# Deep AI Analysis (Gemini)

Phase 12 adds an on-demand Gemini research analysis to each Token Profile. Gemini interprets evidence the platform has already stored. It is not a database agent, it doesn't browse, and it gives no investment advice or predictions.

```
Token Profile ── "Deep AI Analysis" ──► Server Action requestTokenAnalysis(tokenId)
                                                │  token ID must be in the canonical universe
                                                ▼
                        cooldown / hourly cap (token_ai_analyses)
                                                ▼
          loadResearchContext: one token's latest observations, calculated metrics,
          explicit periods, 30-day daily history, freshness, scope, unavailable items
                                                ▼
          Gemini REST generateContent (server-only key, JSON schema output, no tools)
                                                ▼
          validate: structure, enums, cited IDs, advice/prediction language
                                                ▼
          store in token_ai_analyses (append-only)  ──►  render with provenance
```

Page loads only read the newest stored analysis. Gemini is called only when someone clicks **Generate** or **Regenerate**.

## Setup

1. Apply [`supabase/migrations/20260926090000_token_ai_analyses.sql`](../supabase/migrations/20260926090000_token_ai_analyses.sql) in the Supabase SQL Editor as a single script with nothing highlighted. It creates the table and indexes, with RLS on and `service_role` access only. It's safe to re-run.
2. Set server-side environment variables. Never prefix them with `NEXT_PUBLIC_`.

   | Variable | Purpose |
   | --- | --- |
   | `GEMINI_API_KEY` | Enables analysis. When unset, the profile shows "AI analysis unavailable" |
   | `GEMINI_MODEL` | Optional. Defaults to `gemini-3.6-flash`, a current stable general-purpose model per the [Gemini models page](https://ai.google.dev/gemini-api/docs/models) |

## Gemini integration

- The integration uses the REST [`models.generateContent`](https://ai.google.dev/api/generate-content) method with `systemInstruction`, `generationConfig.responseMimeType = "application/json"` and `responseJsonSchema`. See [structured output](https://ai.google.dev/gemini-api/docs/structured-output).
- It uses plain `fetch` with an injectable `fetchImpl`, matching the provider collectors. That adds no new dependency and makes it easy to mock in tests.
- The key is sent only in the `x-goog-api-key` header from server code (`src/lib/analysis/gemini.ts`, marked `server-only`).
- There are at most 2 attempts for 429 or 5xx responses and a 90-second request timeout. Error messages never include the key, URL or response body.
- The response schema sent to Gemini has no `maxItems`: `gemini-3.6-flash` rejected the full schema with nested `maxItems` (HTTP 400 INVALID_ARGUMENT). The validator trims arrays to their limits instead.
- `maxOutputTokens` is 32,768 because thinking tokens count toward it.
- Under load, Gemini returns HTTP 503 ("high demand"). The panel then shows an error and nothing is stored; try again later or set `GEMINI_MODEL` to another available model.
- No tools or grounding are enabled, so the model can't browse or fetch URLs.

## OpenRouter fallback (Phase 14A)

Gemini is the primary provider. [`providers.ts`](../src/lib/analysis/providers.ts) falls back to OpenRouter only on a **temporary** Gemini failure.

1. Call Gemini. Its client already makes at most one bounded retry on HTTP 408, 429 or 5xx, and each attempt is limited to 60 seconds.
2. If Gemini still fails temporarily (408, 429, 5xx, timeout, or a network error), call OpenRouter **once** with no retry. This happens only if `OPENROUTER_API_KEY` is set; otherwise the fallback is skipped.
3. If both fail, the existing controlled "could not be generated" state is shown and nothing is stored.

Permanent Gemini errors never fall back: 400 (bad request or schema), 401 and 403 (authentication), 404 (unsupported model), blocked or truncated output, and responses that fail validation.

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Server-only. Enables the fallback |
| `OPENROUTER_MODEL` | Defaults to `openrouter/free`, OpenRouter's free-model router |

How the OpenRouter call works ([`openrouter.ts`](../src/lib/analysis/openrouter.ts)):
- It sends `POST https://openrouter.ai/api/v1/chat/completions` with the **same** system instruction, research-context user turn and response schema as Gemini.
- The schema is sent as `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}`, with `provider.require_parameters: true` so OpenRouter routes only to endpoints that support structured outputs.
- OpenRouter's models catalogue lists `openrouter/free` with `response_format` and `structured_outputs` support and a 200k-token context.
- The output goes through the same validator as Gemini's. The schema is not relaxed; the only leniency is removing a Markdown code fence around the JSON.

Provenance is stored in `analysis.metadata`:
- `provider` is `"OpenRouter"` when OpenRouter generated the result.
- `model` is the model OpenRouter reports actually serving the request, and it is also written to the table's `model` column.
- `requestedModel` records what was asked for (for example `openrouter/free`), and `upstreamProvider` records OpenRouter's upstream provider when reported.
- `fallback` records `{ used, reason }`, for example `{ used: true, reason: "gemini_503" }`.

The panel shows "Model: OpenRouter · … (via openrouter/free)" and "Fallback: Gemini unavailable (gemini_503)". A fallback result is never labelled as Gemini's.

The Token Profile's `maxDuration` is 300 seconds, enough for two Gemini attempts plus one OpenRouter attempt. A deadline that hits while the response body is still being read is reported as a timeout, not as malformed JSON.

Free models behind `openrouter/free` are chosen by OpenRouter, can be slow, and may be subject to provider data policies (including training on prompts). The research context contains only public market data.

## Research context

The context is built in [`src/lib/analysis/research-context.ts`](../src/lib/analysis/research-context.ts) for one canonical token. It contains:

| Part | Content |
| --- | --- |
| `token` | Canonical ID, name, symbol, chain, contract, category |
| `scope` | Per-provider scope: CoinGecko token-level aggregate; DeFiLlama **protocol-level** record and relationship; DEX Screener exact-address DEX pairs only; unmapped providers are "unavailable by design" |
| `providerFreshness` | Per provider: current, stale or unavailable (using Phase 11B thresholds), token data age, last successful refresh, latest attempt. A failed latest attempt is stated as "last successfully stored observations, not newly collected" |
| `observations` | The latest observation per metric, with value (null when unavailable), timestamps, window, scope, note, and ID `obs:<id>` |
| `calculatedMetrics` | The latest row per calculated metric, with formula, status, unavailable reason, explicit `period`, input IDs, and ID `calc:<id>` |
| `history` | Actual per-window coverage (24H/7D/30D: count, first/last timestamp, span, whether the window is really covered), plus one point per UTC day for 30 days (price, market cap, volume, circulating supply, TVL, fees, revenue), with a deterministic first-to-last summary labelled with its exact timestamps |
| `unavailable` | Consolidated list of unavailable observations, calculated metrics and history series |

Raw provider payloads are not sent. For Uniswap on real data, the prompt is about 44 KB with 94 citable IDs.

## Metric periods

Periods come from stored data, never from metric names ([`metric-periods.ts`](../src/lib/analysis/metric-periods.ts)).

- **Growth metrics** ("latest vs previous"): the actual interval between the two most recent distinct observations, with start, end and duration. For example, real Uniswap price growth currently spans 21 hours, and TVL growth 4.3 hours. The label says the change is not a fixed 24-hour, 7-day or 30-day period.
- **Cross-series spreads and divergence flags:** the timestamp-aligned interval.
- **Ratios:** point-in-time values, noting when their inputs were observed at different times (for example, market cap / TVL inputs 21.8 hours apart).
- **Provider rolling windows:** used only when the provider defines them, via `window_days` or the metric definition. Examples are CoinGecko's 24h and 7d change, 24-hour volume, DEX Screener h24 fields, and DeFiLlama 24-hour totals.
- **No stored start or end:** the period is marked unavailable, and the model is told not to attribute any time period.

## Output schema and validation

[`schema.ts`](../src/lib/analysis/schema.ts) defines the JSON Schema sent to Gemini and the TypeScript types. The analysis has sections A–G (executive summary, market performance, fundamentals, valuation, price vs fundamentals, liquidity and market structure, tokenomics). Each section has an `overview` plus `statements`, and each statement has:
- a `kind`: `observed`, `calculated`, `interpretation` or `uncertainty`;
- its `text`;
- the `sourceIds` it cites;
- its `period`.

Section H lists risks, each marked as `evidence` or `data_limitation`. Section I lists data gaps by category, and section J lists further research questions.

Validation happens before anything is stored or shown:
- **Structure:** types, required sections and enums are checked; malformed or incomplete output is rejected.
- **Citations:** cited IDs must exist in the context. Unknown IDs are dropped and counted, and factual statements left with no valid source are flagged "no traceable source" in the UI.
- **Advice and prediction language** is rejected: "you should buy/sell/hold", "price target", "will rise/reach…", "good investment" and similar.
- **Stored analyses are re-validated** before rendering.

Server metadata records the tokenId, model, prompt/schema/context versions, generation time, context time ("data as of"), context hash, labels for the cited sources, and validation counters.

## Evidence contract (schema v2, prompt v3)

The 2026-09-24 Nemotron Bitcoin output passed the v1 validator even though every section's facts sat in unsourced overviews. [`evidence-rules.ts`](../src/lib/analysis/evidence-rules.ts) and the validator in [`schema.ts`](../src/lib/analysis/schema.ts) now enforce these rules deterministically, against an evidence index built from the research context.

| Rule | Enforcement |
| --- | --- |
| Facts live in sourced statements | Overviews may contain no digits (so no values, dates or amounts) and no named periods. They are limited to three sentences, or one when the section has no statements |
| Every evidence-bearing item is sourced | Every statement, risk and data gap needs at least one valid source ID, and an unknown ID fails the whole response. An observed statement must cite `obs:` or `hist:`, a calculated one `calc:`, and an evidence-based risk must cite data |
| Numbers are grounded | Every number in statement, risk, gap or question text must match a value in the items it cites, within rounding and unit scaling. Derived figures (such as a 95.7% supply share) fail |
| Periods are verbatim | A statement citing time-based evidence must carry a period label copied exactly from a cited item. "24-hour", "7-day", "weekly" and similar wording must be established by a cited item's own window or label; the "not a fixed 24-hour/7-day/30-day period" disclaimer doesn't count |
| No sentiment language | bullish, bearish, momentum, rally, uptrend and "likely to rise/fall" are rejected everywhere, including interpretations |
| No outside premises | Concepts such as issuance, block subsidy, halving, staking, unlocks and regulation are rejected unless the research context itself contains them |
| No asset substitution | Other canonical symbols (for example WBTC in a Bitcoin report) and wrapped or staked aliases are rejected unless the context names them |
| Exact unavailability reasons | When a provider is unmapped for the token, any text about its data must give the mapping reason and must not give another one ("within the last 24 hours", "insufficient history", "stale"). A risk or question passes if its title/detail or question/rationale pair states the reason |
| Research questions | Sources are optional, but a question or rationale containing figures must cite the sources that ground them. The language rules still apply |

All violations are collected together and reported in the error. Stored analyses are re-checked before display using the rules that don't need the context. The v1 Nemotron analysis (id 1) remains in the table but is no longer rendered.

`tests/evidence-contract.test.mjs` uses the real Bitcoin research context and the real Nemotron output from 2026-09-24 (in `tests/fixtures/`). It checks that this output is now rejected for each issue the audit identified.

## Prompt design and security

[`prompt.ts`](../src/lib/analysis/prompt.ts) holds a fixed system instruction. It covers evidence-only analysis, statement classification, citing context IDs, exact period labels, no named periods unless stated, protocol vs token scope, freshness and failed refreshes, gaps not treated as risks, no causation from correlation, no advice or predictions, and treating the context as data.

The user turn is a fixed task plus the context JSON inside `<research_context>` tags. Every `<` in the JSON is escaped, so provider text can't close the block.

The only user input is the token ID, which is validated against the canonical universe before any read. Reads are scoped to that token's rows plus shared definitions and refresh status. The client receives only the validated analysis; never the key, prompt or context. A build scan confirmed that no Gemini key, endpoint, header or prompt text appears in `.next/static`.

## Generation, caching and limits

- Each successful generation is appended to `token_ai_analyses`; regenerations don't overwrite earlier ones. The profile shows the newest analysis with its generation time, "data as of" time and model.
- **Cooldown:** 10 minutes per token between generations.
- **Hourly cap:** 20 generations across all tokens per rolling hour.
- Both limits bound Gemini spending from a public page with no user accounts.
- Two simultaneous first clicks could both pass the cooldown check; this is acceptable at the current scale.

## No-key and failure behavior

- **No `GEMINI_API_KEY`:** the button reads "Unavailable · Gemini not configured" and the panel explains why. Nothing is generated, stored or faked, and the rest of the profile is unaffected.
- **Gemini error, block, truncation or invalid JSON, or a validation failure:** an error message is shown, nothing is stored, and any previous analysis stays displayed.
- **Analysis table missing:** the panel shows "storage has not been set up".

## Tests

`tests/analysis.test.mjs` is part of `pnpm test` and makes no network calls; Gemini is mocked through `fetchImpl`. It covers:
- context construction, canonical identity, observations, calculated metrics and periods;
- missing and unavailable data, staleness, failed refreshes, and scope;
- prompt boundaries, including an injection attempt in a provider note;
- schema validation and malformed or advice-bearing output;
- no-key behavior, Gemini failures, server-only key handling (including a source scan of client components), and no fabricated fallback;
- end-to-end generate, store, cooldown and hourly cap.
