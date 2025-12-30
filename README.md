# stock-prices

A Next.js (App Router) project intended for deployment to Cloudflare Workers using the OpenNext adapter, with a separate cron Worker that pre-fetches and caches ticker logos so visitors never call Massive/Polygon directly.

## API providers (free-tier oriented)
- Finnhub: real-time stock quotes (planned / not yet implemented in the code shown below).
- Massive (Polygon.io): company branding images (logo/icon) for tickers (implemented).

## High-level architecture
### 1) Logo refresh cron Worker (`workers/refresh-logos-cron`)
- Runs on a cron schedule (configured in `workers/refresh-logos-cron/wrangler.jsonc`) and executes the Worker’s `scheduled()` handler.[8][9]
- For each run, processes a small batch of tickers (currently 1 ticker per run via `MAX_TICKERS_PER_RUN = 1`) using a KV cursor (`cfg:cursor`).
- For each ticker:
  - Calls Massive ticker overview endpoint to get `branding.logo_url` and/or `branding.icon_url`.
  - Downloads logo and icon (if available), chooses the smaller file, and stores the bytes in R2 (`LOGOS_CACHE`) at `logos/<TICKER>.<ext>`.
  - Stores metadata (not bytes) in KV (`LOGO_META`) at `ticker:<TICKER>`: `{ key, mime, bytes, source_url, updated_at }`.
- Also writes operational keys into KV:
  - `cfg:tickers` (the canonical ticker list for the app)
  - `lastRun` and `lastRunResult` (debug/status)

Worker HTTP endpoints:
- Public:
  - `GET /logo/<TICKER>`: serves the cached bytes from R2 (no Massive calls).
- Admin (Bearer token):
  - `GET /status`: shows `lastRun`, `lastRunResult`, and which `ticker:*` keys exist.
  - `GET /meta/<TICKER>`: returns the KV metadata JSON.
  - `GET /run`: queues a refresh batch manually (dev/debug).

### 2) Next.js app (OpenNext on Workers)
- API route `GET /api/logos` reads:
  - `cfg:tickers` + `ticker:<TICKER>` metadata from KV
  - corresponding image bytes from R2 using the stored `key`
- It returns a JSON payload of logos as `data:` URIs (base64) to keep the browser from needing direct R2 access.

## Goals (current vs planned)
### Implemented now
- Cache ticker logos in R2 + store metadata in KV so clients never call Massive directly.

### Planned / TODO
- A quotes refresher that calls Finnhub on a controlled schedule, stores quote data in KV, and has Next.js read from KV on a short revalidation interval (e.g., ~5–10 seconds) so clients never call Finnhub directly.

## Setup / commands
### Created with
- `pnpm create cloudflare@latest . --framework=next`

### Dev testing the cron Worker
- **run these in ``workers/refresh-logos-cron``**
- Run: `pnpm dlx wrangler dev --test-scheduled`
- Trigger: `http://localhost:8787/__scheduled` (local scheduled test endpoint).[9]
- Verify KV: `pnpm dlx wrangler kv key get "lastRun" --binding LOGO_META --remote --text`

### Cloud resources
- R2 bucket: `logos-cache` (bound as `LOGOS_CACHE`)
- Workers KV namespace: `LOGO_META`
- `LOGO_META_preview`: previously used, now disconnected / not used

## Environment variables
### `workers/refresh-logos-cron/.dev.vars`
```env
MASSIVE_API_KEY=...   # from Massive dashboard
ADMIN_TOKEN=...       # long random bearer token for /status, /run, /meta/* (you-make-this-up-reference)
```

### `.env.local` (root)
```env
LOGO_WORKER_BASE_URL=http://localhost:8787
LOGO_WORKER_ADMIN_TOKEN= # you-make-this-up-reference
```
Note: the current Next.js flow uses `/api/logos` (and reads KV/R2 directly via bindings) rather than calling the cron Worker over HTTP; these are mainly useful for debugging/admin endpoints and future expansions.

## Notes
- Cron schedules run based on Cloudflare’s cron trigger configuration, and expressions are evaluated in UTC.[8]
- Type generation (for bindings) can be used to avoid TypeScript errors when referencing `KVNamespace`/`R2Bucket` bindings.
