type Env = {
  LOGO_META: KVNamespace;
  LOGOS_CACHE: R2Bucket;
  MASSIVE_API_KEY: string;
  ADMIN_TOKEN: string;
};

const TICKERS = ["META", "AAPL", "AMZN", "MSFT", "GOOGL"] as const;
type Ticker = (typeof TICKERS)[number];

type Branding = { logo_url?: string; icon_url?: string };
type TickerOverviewResponse = { results?: { branding?: Branding } };

type StoredMeta = {
  ticker: Ticker;
  key: string;
  mime: string;
  bytes: number;
  source_url: string;
  updated_at: string;
};

type FetchedImage = {
  url: string;
  mime: string;
  bytes: number;
  bytesBuf: Uint8Array;
};

const CURSOR_KEY = "cfg:cursor";
const MAX_TICKERS_PER_RUN = 1; // dev-safe
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

class RateLimitError extends Error {
  status: number;
  retryAfter?: string | null;

  constructor(message: string, status: number, retryAfter?: string | null) {
    super(message);
    this.name = "RateLimitError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function requireAdmin(req: Request, env: Env): Response | null {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response("forbidden", { status: 403 });
  }
  return null;
}

function parseTickerFromPath(pathname: string, prefix: string): Ticker | null {
  const raw = pathname.slice(prefix.length).replace(/^\/+/, "").toUpperCase();
  const t = raw as Ticker;
  return TICKERS.includes(t) ? t : null;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(refreshBatch(env));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      const lastRun = await env.LOGO_META.get("lastRun");
      return new Response(lastRun ? `ok (lastRun=${lastRun})` : "ok (no lastRun yet)");
    }

    if (url.pathname === "/status") {
      const forbidden = requireAdmin(req, env);
      if (forbidden) return forbidden;

      const lastRun = await env.LOGO_META.get("lastRun");
      const lastRunResult = await env.LOGO_META.get("lastRunResult", "json");
      const keys = await env.LOGO_META.list({ prefix: "ticker:" });

      return Response.json({
        tickers: TICKERS,
        lastRun,
        lastRunResult,
        cachedTickers: keys.keys.map((k) => k.name),
      });
    }

    if (url.pathname === "/run") {
      const forbidden = requireAdmin(req, env);
      if (forbidden) return forbidden;

      ctx.waitUntil(refreshBatch(env));
      return new Response("queued");
    }

    if (url.pathname.startsWith("/meta/")) {
      const forbidden = requireAdmin(req, env);
      if (forbidden) return forbidden;

      const ticker = parseTickerFromPath(url.pathname, "/meta/");
      if (!ticker) return new Response("unknown ticker", { status: 400 });

      const meta = await env.LOGO_META.get(`ticker:${ticker}`);
      return meta
        ? new Response(meta, { headers: { "Content-Type": "application/json" } })
        : new Response("not found", { status: 404 });
    }

    // Public: serve cached bytes (no Massive calls)
    if (url.pathname.startsWith("/logo/")) {
      const ticker = parseTickerFromPath(url.pathname, "/logo/");
      if (!ticker) return new Response("unknown ticker", { status: 400 });

      const meta = (await env.LOGO_META.get(`ticker:${ticker}`, "json")) as StoredMeta | null;
      if (!meta) return new Response("not found", { status: 404 });

      const obj = await env.LOGOS_CACHE.get(meta.key);
      if (!obj || !obj.body) return new Response("not found", { status: 404 });

      const etag = `"${meta.updated_at}"`;
      const inm = req.headers.get("if-none-match");
      if (inm && inm === etag) return new Response(null, { status: 304 });

      return new Response(obj.body, {
        headers: {
          "Content-Type": meta.mime,
          "Cache-Control": "public, max-age=86400",
          ETag: etag,
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
};

async function refreshBatch(env: Env) {
  const ts = new Date().toISOString();
  console.log("[cron] start", ts);
  console.log("Secret:", env.MASSIVE_API_KEY ? "✅ loaded" : "❌ missing");

  // Make ticker list available to Next.js (single source of truth is Worker)
  await env.LOGO_META.put("cfg:tickers", JSON.stringify(TICKERS));

  const results: Array<{
    ticker: Ticker;
    ok: boolean;
    error?: string;
    key?: string;
    status?: number;
    retryAfter?: string | null;
  }> = [];

  // cursor-based batching
  const rawCursor = await env.LOGO_META.get(CURSOR_KEY);
  let cursor = Number.parseInt(rawCursor ?? "0", 10);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

  const batch: Ticker[] = [];
  for (let i = 0; i < Math.min(MAX_TICKERS_PER_RUN, TICKERS.length); i++) {
    batch.push(TICKERS[(cursor + i) % TICKERS.length]);
  }

  const nextCursor = (cursor + batch.length) % TICKERS.length;
  await env.LOGO_META.put(CURSOR_KEY, String(nextCursor));

  for (const ticker of batch) {
    try {
      // freshness skip
      const existing = (await env.LOGO_META.get(`ticker:${ticker}`, "json")) as StoredMeta | null;
      if (existing) {
        const age = Date.now() - Date.parse(existing.updated_at);
        if (Number.isFinite(age) && age >= 0 && age < REFRESH_TTL_MS) {
          results.push({ ticker, ok: true, key: existing.key });
          await env.LOGO_META.put(
            `ticker:${ticker}:result`,
            JSON.stringify({ ok: true, step: "skip_fresh", updated_at: ts })
          );
          console.log(`[cron] ⏭️ ${ticker} fresh -> ${existing.key}`);
          continue;
        }
      }

      const meta = await refreshOneTicker(ticker, env);
      results.push({ ticker, ok: true, key: meta.key });

      await env.LOGO_META.put(
        `ticker:${ticker}:result`,
        JSON.stringify({ ok: true, step: "updated", key: meta.key, updated_at: ts })
      );
      console.log(`[cron] ✅ ${ticker} -> ${meta.key}`);
    } catch (e: unknown) {
      if (e instanceof RateLimitError) {
        results.push({ ticker, ok: false, error: e.message, status: e.status, retryAfter: e.retryAfter });

        await env.LOGO_META.put(
          `ticker:${ticker}:result`,
          JSON.stringify({
            ok: false,
            step: "rate_limited",
            status: e.status,
            retryAfter: e.retryAfter,
            error: e.message,
            updated_at: ts,
          })
        );

        console.log(`[cron] 🛑 ${ticker}: ${e.message} (retry-after=${e.retryAfter ?? "n/a"})`);
        break; // stop early if throttled
      }

      const msg = e instanceof Error ? e.message : "Unknown error";
      results.push({ ticker, ok: false, error: msg });

      await env.LOGO_META.put(
        `ticker:${ticker}:result`,
        JSON.stringify({ ok: false, step: "error", error: msg, updated_at: ts })
      );

      console.log(`[cron] ❌ ${ticker}: ${msg}`);
    }
  }

  await env.LOGO_META.put("lastRun", ts);
  await env.LOGO_META.put("lastRunResult", JSON.stringify({ ts, batch, results }));
  console.log("[cron] done");
}

async function refreshOneTicker(ticker: Ticker, env: Env): Promise<StoredMeta> {
  const apiKey = env.MASSIVE_API_KEY;

  const overviewUrl = `https://api.massive.com/v3/reference/tickers/${ticker}?apiKey=${apiKey}`;
  const overviewRes = await fetch(overviewUrl);

  if (overviewRes.status === 429) {
    throw new RateLimitError("Ticker overview failed (429)", 429, overviewRes.headers.get("retry-after"));
  }
  if (!overviewRes.ok) throw new Error(`Ticker overview failed (${overviewRes.status})`);

  const overviewJson = (await overviewRes.json()) as TickerOverviewResponse;
  const branding = overviewJson.results?.branding;

  const logoUrl = branding?.logo_url ? `${branding.logo_url}?apiKey=${apiKey}` : null;
  const iconUrl = branding?.icon_url ? `${branding.icon_url}?apiKey=${apiKey}` : null;

  if (!logoUrl && !iconUrl) throw new Error("No branding.logo_url or branding.icon_url");

  const [logo, icon] = await Promise.all([
    logoUrl ? fetchImageBytes(logoUrl) : Promise.resolve(null),
    iconUrl ? fetchImageBytes(iconUrl) : Promise.resolve(null),
  ]);

  const chosen = chooseSmaller(logo, icon);
  if (!chosen) throw new Error("Both logo/icon fetch failed");

  const ext = mimeToExt(chosen.mime, chosen.url);
  const key = `logos/${ticker}.${ext}`;

  await env.LOGOS_CACHE.put(key, chosen.bytesBuf, {
    httpMetadata: { contentType: chosen.mime },
  });

  const meta: StoredMeta = {
    ticker,
    key,
    mime: chosen.mime,
    bytes: chosen.bytes,
    source_url: chosen.url,
    updated_at: new Date().toISOString(),
  };

  await env.LOGO_META.put(`ticker:${ticker}`, JSON.stringify(meta));
  return meta;
}

async function fetchImageBytes(url: string): Promise<FetchedImage | null> {
  const res = await fetch(url);

  if (res.status === 429) {
    throw new RateLimitError("Image fetch failed (429)", 429, res.headers.get("retry-after"));
  }
  if (!res.ok) return null;

  const mime = res.headers.get("content-type") || inferMimeFromUrl(url);
  const ab = await res.arrayBuffer();
  const u8 = new Uint8Array(ab);

  return { url, mime, bytes: u8.byteLength, bytesBuf: u8 };
}

function chooseSmaller(a: FetchedImage | null, b: FetchedImage | null): FetchedImage | null {
  if (a && b) return a.bytes <= b.bytes ? a : b;
  return a ?? b ?? null;
}

function inferMimeFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes(".svg")) return "image/svg+xml";
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function mimeToExt(mime: string, url: string): string {
  const m = mime.toLowerCase();
  if (m.includes("svg")) return "svg";
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";

  const lower = url.toLowerCase();
  if (lower.includes(".svg")) return "svg";
  if (lower.includes(".png")) return "png";
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return "jpg";
  return "bin";
}
