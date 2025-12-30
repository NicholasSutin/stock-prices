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
const BLOCKED_UNTIL_KEY = "cfg:blockedUntil";
const CYCLE_ACTIVE_UNTIL_KEY = "cfg:cycleActiveUntil";
const LAST_MINUTE_RUN_KEY = "cfg:lastMinuteRun";

const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

// Must match wrangler.jsonc exactly if you want “start cycle” logic.
const DAILY_CRON = "30 14 * * *"; // 9:30 EST in UTC
const MINUTE_CRON = "* * * * *";

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

function parseRetryAfterMs(retryAfter: string | null | undefined): number | null {
  if (!retryAfter) return null;
  const sec = Number(retryAfter);
  if (Number.isFinite(sec) && sec > 0) return Math.floor(sec * 1000);

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) {
    const ms = dateMs - Date.now();
    return ms > 0 ? ms : null;
  }
  return null;
}

async function getNumberKV(env: Env, key: string): Promise<number | null> {
  const raw = await env.LOGO_META.get(key);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function setNumberKV(env: Env, key: string, value: number) {
  await env.LOGO_META.put(key, String(value));
}

async function clearKV(env: Env, key: string) {
  await env.LOGO_META.delete(key);
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 1) Daily cron: arm a “cycle window” and reset cursor.
    if (event.cron === DAILY_CRON) {
      ctx.waitUntil(startCycle(env));
      return;
    }

    // 2) Every-minute cron: do at most one ticker per minute while cycle is active.
    // (If you only configure one cron, it will still work: it will just no-op unless active.)
    if (event.cron === MINUTE_CRON) {
      ctx.waitUntil(runMinute(env));
      return;
    }

    // Fallback: treat unknown cron as minute runner
    ctx.waitUntil(runMinute(env));
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
      const cursor = await env.LOGO_META.get(CURSOR_KEY);
      const blockedUntil = await env.LOGO_META.get(BLOCKED_UNTIL_KEY);
      const cycleActiveUntil = await env.LOGO_META.get(CYCLE_ACTIVE_UNTIL_KEY);

      return Response.json({
        tickers: TICKERS,
        cursor,
        blockedUntil,
        cycleActiveUntil,
        lastRun,
        lastRunResult,
        cachedTickers: keys.keys.map((k) => k.name),
      });
    }

    // Admin: manually start a cycle now (useful in dev; not needed in production)
    if (url.pathname === "/start") {
      const forbidden = requireAdmin(req, env);
      if (forbidden) return forbidden;

      ctx.waitUntil(startCycle(env));
      return new Response("cycle started");
    }

    // Admin: manually run one minute “tick” now
    if (url.pathname === "/tick") {
      const forbidden = requireAdmin(req, env);
      if (forbidden) return forbidden;

      ctx.waitUntil(runMinute(env));
      return new Response("tick queued");
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

async function startCycle(env: Env) {
  // publish tickers list for Next.js
  await env.LOGO_META.put("cfg:tickers", JSON.stringify(TICKERS));

  // reset cursor so the cycle is deterministic
  await env.LOGO_META.put(CURSOR_KEY, "0");

  // clear any previous block so we attempt again today
  await clearKV(env, BLOCKED_UNTIL_KEY);

  // keep the cycle “active” long enough to do 1 ticker/minute for all tickers + a little buffer
  const bufferMs = 2 * 60 * 1000;
  const activeForMs = TICKERS.length * 60 * 1000 + bufferMs;
  await setNumberKV(env, CYCLE_ACTIVE_UNTIL_KEY, Date.now() + activeForMs);

  console.log("[cycle] started", { activeForMs, tickers: TICKERS.length });
}

async function runMinute(env: Env) {
  // only do work when a cycle is active
  const activeUntil = (await getNumberKV(env, CYCLE_ACTIVE_UNTIL_KEY)) ?? 0;
  if (!activeUntil || Date.now() > activeUntil) return;

  // enforce “at most once per minute” even if cron overlaps
  const lastMinute = (await getNumberKV(env, LAST_MINUTE_RUN_KEY)) ?? 0;
  if (Date.now() - lastMinute < 55_000) return;
  await setNumberKV(env, LAST_MINUTE_RUN_KEY, Date.now());

  // respect upstream rate limiting
  const blockedUntil = (await getNumberKV(env, BLOCKED_UNTIL_KEY)) ?? 0;
  if (blockedUntil && Date.now() < blockedUntil) return;

  // process exactly one ticker
  await refreshOneFromCursor(env);

  // if we wrapped cursor back to 0, the cycle is complete; turn off “active”
  const curRaw = await env.LOGO_META.get(CURSOR_KEY);
  const cur = Number.parseInt(curRaw ?? "0", 10);
  if (Number.isFinite(cur) && cur === 0) {
    await clearKV(env, CYCLE_ACTIVE_UNTIL_KEY);
    console.log("[cycle] complete");
  }
}

async function refreshOneFromCursor(env: Env) {
  const ts = new Date().toISOString();
  console.log("[cron] tick", ts);

  await env.LOGO_META.put("cfg:tickers", JSON.stringify(TICKERS));

  let cursor = Number.parseInt((await env.LOGO_META.get(CURSOR_KEY)) ?? "0", 10);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

  const ticker = TICKERS[cursor % TICKERS.length];

  const results: Array<{
    ticker: Ticker;
    ok: boolean;
    error?: string;
    key?: string;
    status?: number;
    retryAfter?: string | null;
    step?: string;
  }> = [];

  try {
    const existing = (await env.LOGO_META.get(`ticker:${ticker}`, "json")) as StoredMeta | null;
    if (existing) {
      const age = Date.now() - Date.parse(existing.updated_at);
      if (Number.isFinite(age) && age >= 0 && age < REFRESH_TTL_MS) {
        results.push({ ticker, ok: true, key: existing.key, step: "skip_fresh" });
        await env.LOGO_META.put(
          `ticker:${ticker}:result`,
          JSON.stringify({ ok: true, step: "skip_fresh", updated_at: ts })
        );
        console.log(`[cron] ⏭️ ${ticker} fresh -> ${existing.key}`);
        // advance cursor even if fresh
        await env.LOGO_META.put(CURSOR_KEY, String((cursor + 1) % TICKERS.length));
      } else {
        const meta = await refreshOneTicker(ticker, env);
        results.push({ ticker, ok: true, key: meta.key, step: "updated" });

        await env.LOGO_META.put(
          `ticker:${ticker}:result`,
          JSON.stringify({ ok: true, step: "updated", key: meta.key, updated_at: ts })
        );
        console.log(`[cron] ✅ ${ticker} -> ${meta.key}`);

        await env.LOGO_META.put(CURSOR_KEY, String((cursor + 1) % TICKERS.length));
      }
    } else {
      const meta = await refreshOneTicker(ticker, env);
      results.push({ ticker, ok: true, key: meta.key, step: "updated" });

      await env.LOGO_META.put(
        `ticker:${ticker}:result`,
        JSON.stringify({ ok: true, step: "updated", key: meta.key, updated_at: ts })
      );
      console.log(`[cron] ✅ ${ticker} -> ${meta.key}`);

      await env.LOGO_META.put(CURSOR_KEY, String((cursor + 1) % TICKERS.length));
    }
  } catch (e: unknown) {
    if (e instanceof RateLimitError) {
      const delayMs = parseRetryAfterMs(e.retryAfter) ?? 60_000; // fallback: 1 minute
      const until = Date.now() + delayMs;

      await setNumberKV(env, BLOCKED_UNTIL_KEY, until);

      // extend cycle window so it can continue after backoff
      const activeUntil = (await getNumberKV(env, CYCLE_ACTIVE_UNTIL_KEY)) ?? 0;
      if (activeUntil) await setNumberKV(env, CYCLE_ACTIVE_UNTIL_KEY, activeUntil + delayMs);

      results.push({ ticker, ok: false, error: e.message, status: e.status, retryAfter: e.retryAfter, step: "rate_limited" });

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
    } else {
      const msg = e instanceof Error ? e.message : "Unknown error";
      results.push({ ticker, ok: false, error: msg, step: "error" });

      await env.LOGO_META.put(
        `ticker:${ticker}:result`,
        JSON.stringify({ ok: false, step: "error", error: msg, updated_at: ts })
      );

      console.log(`[cron] ❌ ${ticker}: ${msg}`);

      // advance cursor on non-rate-limit errors to avoid getting stuck
      await env.LOGO_META.put(CURSOR_KEY, String((cursor + 1) % TICKERS.length));
    }
  }

  await env.LOGO_META.put("lastRun", ts);
  await env.LOGO_META.put("lastRunResult", JSON.stringify({ ts, batch: [ticker], results }));
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
