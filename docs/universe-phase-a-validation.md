# Phase A validation

This is a live-validation and correctness review of the Phase A candidate-universe implementation (`docs/universe-phase-a.md`), not a Phase B ranking exercise. It records what a real `pnpm universe:validate` run needs, why it could not be executed against the real ~2,500-candidate pool in this sandboxed session, two genuine correctness bugs this review found and fixed, and the evidence that the corrected pipeline behaves as specified.

## Live run: exact blocker

`pnpm universe:validate` could not be run against real CoinGecko/Binance/Supabase data here. Three independent, confirmed blockers, reproduced directly rather than assumed:

1. **No credentials configured.** `pnpm universe:validate` (persist mode): `Supabase is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY in the server environment.` `pnpm universe:validate --dry-run`: `Set COINGECKO_API_KEY in the ignored root .env.local file.`
2. **Outbound network to both providers is denied by this sandbox's organization egress policy**, independent of credentials:
   ```
   $ curl https://api.coingecko.com/api/v3/ping
   curl: (56) CONNECT tunnel failed, response 403
   $ curl https://api.binance.com/api/v3/ping
   curl: (56) CONNECT tunnel failed, response 403
   [agent-proxy] ... connect_rejected (the egress proxy denied the CONNECT (organization policy) ...)
   ```
3. **Confirmed even with a credential supplied**: running with a dummy `COINGECKO_API_KEY` gets past config validation and reaches the actual HTTP layer, which is where the policy denial surfaces:
   ```
   $ COINGECKO_API_KEY=dummy-key-for-blocker-demo pnpm universe:validate --dry-run --pool-size=250
   Phase A validation did not run: CoinGecko /coins/markets returned HTTP 403.
   ```

No results were fabricated to work around this. Every count below is either the exact CLI/curl output above, or explicitly labeled fixture-based test output used to verify pipeline *logic*, never presented as real market data.

## Two confirmed bugs found and fixed during this review

Both were found by re-deriving what "confirmed" vs. "temporary" vs. "absent" actually mean in the code, not by assumption, and both are proven by new regression tests (`tests/universe-phase-a-identity.test.mjs`, `tests/universe-phase-a-orchestrator.test.mjs`, `tests/universe-phase-a-coingecko.test.mjs`, `tests/universe-phase-a-historical.test.mjs`).

### 1. Deprecation-by-absence conflated "outside this run's ranked pool" with "confirmed delisted"

**Before:** a previously-tracked candidate not present in `discoveredIds` (the top-`poolSize`, ranked-by-market-cap `/coins/markets` window) was marked `deprecated` immediately. A token drifting from rank #2,499 to #2,501 on an ordinary volatile day — still fully listed on CoinGecko — would have been wrongly deprecated on the very next run.

**Fix:** `discoverCandidates` now also returns `listedCoingeckoIds` (from `/coins/list`, CoinGecko's near-complete catalog) and `listOutage` (set only if that fetch itself failed). `duplicates.ts`'s `applyCatalogAbsenceDeprecation` now:
- Leaves a candidate untouched if it's merely outside the ranked pool but still in `/coins/list`.
- Never treats a `/coins/list` fetch failure as absence evidence either way.
- Raises `needs_review` (not `deprecated`) on a single confirmed absence, incrementing `absent_from_source_streak` (new column).
- Only promotes to `deprecated` after `absenceConfirmationThreshold` (default 3) *consecutive* confirmed absences.
- Resets the streak to 0 the moment a candidate reappears.

New migration: `supabase/migrations/20260930090000_universe_absence_streak.sql`.

### 2. Provider outages during re-validation were silently reverting previously-resolved data, not just marking it temporary

**Before:** on every re-run, a re-discovered candidate was rebuilt from a blank template (`newCandidateFromMarket`) and only had `id`/`tokenId`/`universeStatus`/absence-streak copied from the stored row — never its previously-resolved `binance_*`, `logo_*`, `historical_*`, or `supply_*` fields. Normally this is invisible because those fields get freshly recomputed in the same run. But if Binance or the historical-data endpoint was down for that run, the "outage" helper functions (`binanceUnavailable`, `historicalUnavailable`) themselves *also* nulled out the previously-resolved pair/coverage fields — so a token with a perfectly good `BTCUSDT` Spot mapping from yesterday would show `binanceSymbol: null` today, on a Binance hiccup that had nothing to do with that mapping. This directly contradicts AGENTS.md #25 and #30 ("do not destroy previously valid mappings because a provider is temporarily unavailable").

**Fix, two parts:**
- `binanceUnavailable` and `historicalUnavailable` now return a narrow `Pick` (status/timestamp/reason only) instead of a full result with the substantive fields nulled — so spreading them over a candidate leaves the prior value untouched.
- The re-validation merge in `run-validation.ts` now starts from the **previous stored row** (`{...previous, ...freshIdentityFields}`) instead of a blank template, so any field a later step doesn't get to refresh this run (due to an outage) still has last-known-good data to fall back to, not `null`.

Proven by `tests/universe-phase-a-orchestrator.test.mjs`: *"a Binance-wide outage marks affected candidates temporarily_unavailable without wiping their prior Binance mapping"* and *"a historical-data-provider outage during re-validation preserves the previously-measured coverage span"*.

### Also corrected while reviewing: the historical-data minimum was too lenient

The original default, `historicalRequiredDays: 30`, was derived from the Dashboard's "TVL · 30d" metric, not from the app's actual Technical Analysis requirements. `src/lib/indicators/catalog.ts` — the code that actually computes the Dashboard's technical indicators — declares each indicator's own `minPoints`; the largest is **MACD (12, 26, 9) at 61** ("2 × 26 + 9 = 61 closes", per its own `formula` string). A candidate with only 30–43 days of history could not run the existing MACD indicator at all. `historicalRequiredDays` is now **61**, matching what the existing application itself already requires, per AGENTS.md #17's explicit instruction to derive this from "the current chart/TA/risk implementation" rather than inventing a number.

## Candidate universe size (target vs. actual)

```
Configured candidate target: 2,500 (config.ts candidatePoolSize, unchanged from Phase A — configurable, never hard-coded to 1,000)
Actual candidate count this session: 0 (no live run executed — see blocker above)
```

No investigation into "why the count is low" applies: the pipeline was never able to make a single real provider request in this environment.

## Eligibility statistics

**No real statistics exist.** Every number that would populate the section-4/19 tables (CoinGecko valid/not-found/incomplete/temporary, Binance Spot valid/futures-only/non-trading/unresolved, identity valid/duplicate/migrated/deprecated/collision/needs-review, logo/historical/supply breakdowns, final eligible/needs_review/temporarily_unavailable/ineligible, and the CoinGecko-AND-Binance intersection) requires a live run this sandbox cannot perform. Reporting placeholder numbers here would be fabrication; none are given.

What can be reported honestly is the **fixture-based correctness demonstration** already in the test suite (`tests/universe-phase-a-orchestrator.test.mjs`, 6 synthetic candidates, mocked HTTP — not real market data, used only to prove the pipeline's logic is correct):

| Candidate | CoinGecko | Binance | Identity | Logo | History | Supply | Eligibility | Reason(s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bitcoin (BTC) | PASS | PASS (direct_usdt, BTCUSDT) | valid | PASS | PASS | PASS | **eligible** | — |
| Futures Coin (FUTC) | PASS | FAIL (futures_only) | valid | PASS | PASS | PASS | **ineligible** | BINANCE_FUTURES_ONLY |
| Thin History Coin (THIN) | PASS | PASS (direct_usdt) | valid | PASS | FAIL | PASS | **ineligible** | HISTORICAL_DATA_INSUFFICIENT |
| No Logo Coin (NOLOGO) | PASS | PASS (direct_usdt) | valid | FAIL | PASS | PASS | **ineligible** | LOGO_UNAVAILABLE |
| Dup A (DUPSYM) | PASS | not attempted | collision | PASS | not attempted | PASS | **needs_review** | IDENTITY_COLLISION |
| Dup B (DUPSYM) | PASS | not attempted | collision | PASS | not attempted | PASS | **needs_review** | IDENTITY_COLLISION |

Summary: 6 candidates · 5 CoinGecko-valid · 3 Binance-Spot-valid · 3 both-valid · 1 eligible · 2 needs_review · 0 temporarily_unavailable · 3 ineligible. This is a correctness fixture, not evidence about the real candidate pool's size or quality.

## Can Token Samurai eventually support 1,000 eligible tokens?

**Cannot be answered from real data in this session.** The only honest inputs available are: (a) the configured pool size (2,500, well above 1,000, satisfying AGENTS.md #4's "candidate pool larger than the eventual 1,000"), and (b) the corrected eligibility engine's behavior on synthetic data, which is deterministic and matches spec. Whether the *real* CoinGecko + Binance Spot intersection across 2,500 ranked assets exceeds 1,000 is exactly the question a live run answers, and none ran. This must be re-checked with real credentials and network access before Phase B begins.

## Binance pair-resolution distribution

Not available from real data (same blocker). The resolution hierarchy itself (`direct_usdt` → `direct_usdc` → `approved_stable` → `btc_route` → `eth_route` → unresolved) is fully exercised and passes in `tests/universe-phase-a-binance.test.mjs` (13 cases, including Spot-vs-Futures separation, non-trading rejection, and BTC/ETH routes only resolving when the conversion leg itself is tradable), but that is unit coverage, not a real distribution across real assets.

## Deprecation/migration review

Before this review, absence-based deprecation could not distinguish "provider did not return the asset this run" from "confirmed gone" — see bug #1 above. After the fix:

- **Confirmed deprecated/migrated**: only via (a) the hand-verified curated lists (`src/data/universe-known-migrations.ts`), or (b) `absenceConfirmationThreshold` (3) *consecutive* runs confirming absence from CoinGecko's own `/coins/list` catalog.
- **Provider did not return the asset (this run only)**: `needs_review`, streak incremented, never `deprecated` on a single occurrence.
- **Provider temporarily unavailable** (the `/coins/list` fetch itself failed): no status change at all, streak untouched — see `listOutage` in `coingecko-discovery.ts`.

This is now the safer model the task specification calls for. Verified by `tests/universe-phase-a-identity.test.mjs` (7 dedicated cases) and two orchestrator-level tests exercising the full 3-run escalation path.

## Data-quality findings

- **Logo**: correctly distinguishes genuine unavailability (`fail`, no source at all) from a temporary fetch failure (`temporarily_unavailable`, existing URL preserved) — already correct before this review; unaffected by either bug.
- **Historical**: minimum requirement corrected from 30 to 61 days (see above); outage handling fixed (bug #2) so a transient market-chart failure no longer erases a previously-measured coverage span.
- **Supply/reference**: unaffected by either bug (pure, synchronous, no outage state possible); still never invents a value — `needs_review` when only market cap/FDV exist without circulating supply, `fail` only when none of the three exist at all.

## 1,000 feasibility

```
Eligible candidate pool >= 1,000: CANNOT BE DETERMINED — no live run executed in this environment.
```

## Known limitations

- Live execution requires network egress to `api.coingecko.com` and `api.binance.com` (denied here by organization policy) plus `COINGECKO_API_KEY` and `SUPABASE_URL`/`SUPABASE_SECRET_KEY`. None of the eligibility logic itself is blocked — only this sandbox's ability to reach the providers.
- `src/data/universe-binance-symbol-overrides.ts` is empty by design; no symbol collision in the (never-yet-fetched) real candidate pool has been hand-verified. The first live run will very likely surface real collisions that land in `needs_review` until someone verifies and adds an override.
- The Binance logo fallback remains a documented no-op (no stable public endpoint); CoinGecko + an existing verified logo cover the realistic majority of candidates.
- `absenceConfirmationThreshold` (3 runs) and `historicalRequiredDays` (61) are configurable defaults, not verified against real-world catalog churn or a broader historical-coverage survey — both should be revisited once real run data exists.

## Phase A status

```
NOT READY FOR PHASE B — specific blocker:
```

Not because of a code defect (all confirmed defects found in this review are fixed, tested, and merged), but because **no live validation run has ever executed against the real candidate universe**. Phase B's stated job is to evaluate market quality for the *eligible* subset Phase A produces; that subset does not exist yet in this environment. The concrete next step is: run `pnpm universe:validate` with `COINGECKO_API_KEY` and `SUPABASE_URL`/`SUPABASE_SECRET_KEY` configured, from an environment whose network policy allows `api.coingecko.com` and `api.binance.com`, then re-run this validation review against the real output.
