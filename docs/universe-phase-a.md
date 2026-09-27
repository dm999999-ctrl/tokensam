# Universe Phase A: candidate-universe eligibility

Phase A builds and validates a **candidate universe** far larger than the eventual Active 1,000, so Phase D has enough eligible candidates to select an Active set plus a reserve pool. It does **not** select, rank, or score market quality — that is Phase B (market quality), Phase C (external coverage) and Phase D (ranking/selection). See the architecture in `AGENTS.md`.

This is deliberately separate infrastructure from the existing 100/238-token curated universe described in [token-universe.md](token-universe.md). That table (`tokens`, `provider_token_mappings`, and everything the Dashboard and Token Profiles read) is untouched. Phase A's output lives in its own table, `universe_candidates`, and nothing reads from it yet — the Dashboard keeps using the curated universe until Phase D.5/E introduce `getActiveTokenUniverse()`.

## Schema

`supabase/migrations/20260929090000_universe_phase_a.sql` adds:

- **`universe_candidates`** — one row per canonical CoinGecko ID (the strongest identity CoinGecko gives), with every Phase A concern as its own column group: identity (`chain_id`, `contract_address`, `is_native`, `token_id`, `identity_status`), universe/lifecycle status (`universe_status`, `duplicate_of_id`, `migrated_to_coingecko_id`), CoinGecko validation (`coingecko_*`), Binance Spot validation (`binance_*`), logo (`logo_*`), historical data (`historical_*`), supply/reference data (`has_*supply*`, `supply_*`), and the eligibility engine's own output (`eligibility_status`, `eligibility_reason_codes`, ...). `token_id` optionally links a candidate to an existing curated `tokens.id` once confidently matched (see below) — this is how Phase A "reuses existing token identity" without merging the two tables.
- **`universe_validation_runs`** — one row per end-to-end run, for auditing and as Phase B's future input.
- A `binance` row in `data_providers`, for validation metadata only. **No Binance ticks, prices, or order-book data are ever stored** — only `exchangeInfo` market-existence/status fields.

Nothing is ever deleted. Duplicate, deprecated, and migrated candidates keep every field; only `universe_status` and `status_reason` change.

### Deprecation-by-absence: confirmed evidence, not a single missed fetch

A candidate falling out of this run's ranked top-`poolSize` `/coins/markets` window is **not** deprecation evidence — a token can drift from rank #2,499 to #2,501 on an ordinary volatile day without being delisted. The only signal `duplicates.ts` trusts is absence from CoinGecko's own near-complete `/coins/list` catalog, and even that is not acted on immediately: a single confirmed absence only raises `needs_review` and increments `absent_from_source_streak`; only `absenceConfirmationThreshold` (default 3) *consecutive* confirmed absences promote a candidate to `deprecated`. A `/coins/list` fetch failure is recorded as its own `listOutage` and never counted as absence evidence in either direction. Reappearing resets the streak to 0. See `tests/universe-phase-a-identity.test.mjs` and the absence-specific cases in `tests/universe-phase-a-orchestrator.test.mjs`.

## Modules (`src/lib/universe/`)

| Module | Responsibility |
| --- | --- |
| `config.ts` | The single `UniverseEligibilityConfig` (AGENTS.md #21): which requirements are hard, the historical-days minimum, Binance quote priority, candidate pool size. Nothing else hard-codes a threshold. |
| `types.ts` | The `UniverseCandidate` shape and the explicit `REASON_CODES` enum. |
| `coingecko-discovery.ts` | Builds the candidate pool from CoinGecko's own `/coins/markets` (paginated, 250/page) and `/coins/list?include_platform=true` (chain/contract identity) — never a hand-typed token list. |
| `coingecko-validation.ts` | PASS/FAIL/TEMPORARY on the already-fetched market row: no extra request per candidate. |
| `binance-client.ts` / `binance-resolver.ts` | One Spot `exchangeInfo` + one Futures `exchangeInfo` call validates the *entire* pool. Preferred hierarchy: USDT → USDC → approved stablecoin → BTC route → ETH route → unresolved. Spot and Futures are hard-separated; a Futures-only listing is `BINANCE_FUTURES_ONLY`, never silently accepted. |
| `identity.ts` | Resolves whether a Binance base-asset symbol confidently belongs to one candidate. A symbol colliding across the pool stays `needs_review` unless a hand-verified entry exists in `src/data/universe-binance-symbol-overrides.ts` (empty by default — nothing is guessed). |
| `duplicates.ts` | Contract-address duplicates, curated migrations/deprecations (`src/data/universe-known-migrations.ts`), and confirmed-absence deprecation (see below — absence is never trusted on a single fetch). |
| `logo.ts` | CoinGecko (trusted CDN, no live check needed) → Binance (no stable public endpoint exists, so this step is a documented no-op, not a guess) → existing Token Samurai logo (live-verified) → unavailable. |
| `historical.ts` | Coverage-days check via `/coins/{id}/market_chart`, the one genuinely per-candidate request; bounded concurrency + pacing, and only run for candidates that already passed the cheaper CoinGecko + identity checks. |
| `supply.ts` | Circulating supply present → pass; market cap or reported FDV present but no circulating supply → `needs_review`; nothing at all → `fail`. Never invents a value. |
| `eligibility.ts` | The deterministic engine: hard failure always wins → `ineligible`; else any provider outage → `temporarily_unavailable`; else an unresolved identity/needs-review check → `needs_review`; else `eligible`. No market-cap, volume, or liquidity signal appears here. |
| `persist.ts` | Idempotent upsert on `coingecko_id`. Re-running never duplicates a row. |
| `report.ts` | The machine-readable (JSON) and human-readable (Markdown) validation report, with the summary counts AGENTS.md's Definition of Done requires. |
| `run-validation.ts` | The orchestrator: discover → validate CoinGecko → resolve identity/duplicates → resolve Binance → resolve logo/historical/supply → score eligibility → report. |

## Running it

```bash
pnpm universe:validate                 # live run: discovers, validates, persists, writes docs/universe-phase-a-report.{md,json}
pnpm universe:validate --dry-run       # same, but nothing is written to Supabase
pnpm universe:validate --pool-size=3000
```

Requires `COINGECKO_API_KEY` (same variable the existing collectors use) and, for persistence, `SUPABASE_URL`/`SUPABASE_SECRET_KEY`. Binance's `exchangeInfo` endpoints are public and need no key.

## Verified in this environment

This session's outbound network access could not reach `api.coingecko.com` or `api.binance.com` (denied by the sandbox's egress policy), and no `COINGECKO_API_KEY`/`SUPABASE_*` credentials were configured, so a live run against the real ~2,500-token candidate pool could not be executed here. Every module is instead verified with mocked HTTP fixtures in `tests/universe-phase-a-*.test.mjs` (67 assertions across identity, CoinGecko, Binance, logo, historical, supply and eligibility), including a full end-to-end orchestrator run (`universe-phase-a-orchestrator.test.mjs`) over a small fixture pool that exercises every terminal outcome: eligible (direct-USDT Spot match), ineligible via `BINANCE_FUTURES_ONLY`, ineligible via `HISTORICAL_DATA_INSUFFICIENT`, ineligible via `LOGO_UNAVAILABLE`, and `needs_review` via an unresolved symbol collision — plus a provider-outage run proving previously-valid data survives a CoinGecko outage, and a double-persist run proving idempotency. Run `pnpm universe:validate` with network access and credentials to produce the real report against the live candidate pool.

## Future phases

- **Phase B** reads `universe_candidates` where `eligibility_status = 'eligible'` and adds market-quality columns (volume, spread, depth) — none of which exist here.
- **Phase C** adds external-coverage metadata (DeFiLlama/DexScreener/GeckoTerminal) as further columns or a linked table.
- **Phase D** ranks eligible candidates and selects the Active 1,000 + reserve pool; `universe_validation_runs` is its audit input.
- **Phase D.5/E** introduce `getActiveTokenUniverse()` and the Binance live WebSocket layer, using `binance_symbol`/`binance_resolution_method` as the ready-made mapping.
