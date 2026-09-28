# Token Samurai refresh scheduler (Cloudflare Worker)

External clock for both of Token Samurai's scheduled routes:

- `/api/cron/refresh` — CoinGecko, DEX Screener, DeFiLlama, DeFiLlama Coins.
- `/api/cron/geckoterminal` — GeckoTerminal on-chain data.

Vercel's Hobby plan cannot run its own Cron Trigger more often than once a
day, but both routes are designed to be invoked far more often than they
actually do work: each one has its own due-check (`isProviderDue()` /
`REFRESH_POLICY` for the refresh route, `GECKOTERMINAL_SYNC_INTERVAL` for the
GeckoTerminal route) that makes a tick where nothing is due return almost
immediately. This Worker's job is only to provide that frequent tick — every
5 minutes — via a Cloudflare Cron Trigger, which Cloudflare's free tier
supports. All actual scheduling logic (which provider runs when, GeckoTerminal
rotation/lock/pacing) stays server-side in the Next.js app; this Worker does
not decide anything beyond "call both routes now."

`vercel.json` still declares a once-daily Vercel Cron entry for
`/api/cron/refresh` as a fallback in case this Worker is ever down; that
entry alone is not enough to keep either route's intended cadence, which is
why this Worker exists.

## Deploy

```bash
cd cloudflare/refresh-scheduler
pnpm install   # or npm install
npx wrangler secret put CRON_SECRET   # paste the same value as the Vercel project's CRON_SECRET
```

Set `REFRESH_URL` in `wrangler.toml` to the Vercel production **base** URL —
not the complete `/api/cron/refresh` URL — e.g. `https://tokensam.vercel.app`
(no trailing slash needed). The Worker appends `/api/cron/refresh` and
`/api/cron/geckoterminal` to it itself. Then:

```bash
npx wrangler deploy
```

## Verify

```bash
npx wrangler tail
```

Trigger a tick manually with `npx wrangler deployments list` / the dashboard's
"Trigger event," or just visit the Worker's own URL — `fetch()` runs the same
logic as `scheduled()` and returns each route's status as JSON, so it can be
smoke-tested without waiting for the next 5-minute tick.

## What each tick actually costs

- `/api/cron/refresh`: cheap when nothing is due (an empty `due` list); at
  most every 15 minutes it will actually collect CoinGecko/DEX Screener, at
  most every 30 for DeFiLlama Coins, and every 6 hours for DeFiLlama.
- `/api/cron/geckoterminal`: returns `{"status":"skipped","reason":"not_due"}`
  on roughly two out of every three ticks; the third tick actually collects
  a rotation batch (~30 tokens, 6.5 s apart, bounded to ~270 s). A tick that
  lands while a previous collection is still running gets `{"status":"busy"}`
  (HTTP 409) instead of starting a second, overlapping run — the existing
  `geckoterminal_sync_runs` lock (see `src/lib/providers/geckoterminal-sync-lock.ts`)
  already prevents that regardless of what triggers the request.
