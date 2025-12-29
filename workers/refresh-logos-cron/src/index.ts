type Env = {
  LOGO_META: KVNamespace;
  LOGOS_CACHE: R2Bucket;
  MASSIVE_API_KEY: string;
};

const TICKERS = ["META", "AAPL", "AMZN", "MSFT", "GOOGL"] as const;
type Ticker = (typeof TICKERS)[number];

type Branding = {
  logo_url?: string;
  icon_url?: string;
};

type TickerOverviewResponse = {
  results?: {
    branding?: Branding;
  };
};

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

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(refreshAll(env));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      const lastRun = await env.LOGO_META.get("lastRun");
      return new Response(lastRun ? `ok (lastRun=${lastRun})` : "ok (no lastRun yet)");
    }

    if (url.pathname === "/status") {
      const lastRun = await env.LOGO_META.get("lastRun");
      const keys = await env.LOGO_META.list({ prefix: "ticker:" });
      return Response.json({
        tickers: TICKERS,
        lastRun,
        cachedTickers: keys.keys.map((k) => k.name),
      });
    }

    if (url.pathname === "/run") {
      ctx.waitUntil(refreshAll(env));
      return new Response("queued");
    }

    if (url.pathname.startsWith("/meta/")) {
      const ticker = url.pathname.split("/").pop()?.toUpperCase() as Ticker | undefined;
      if (!ticker || !TICKERS.includes(ticker)) return new Response("unknown ticker", { status: 400 });

      const meta = await env.LOGO_META.get(`ticker:${ticker}`);
      return meta ? new Response(meta, { headers: { "Content-Type": "application/json" } }) : new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  },
};

async function refreshAll(env: Env) {
  const ts = new Date().toISOString();
  console.log("[cron] start", ts);
  console.log("Secret:", env.MASSIVE_API_KEY ? "✅ loaded" : "❌ missing");

  const results: Array<{ ticker: Ticker; ok: boolean; error?: string; key?: string }> = [];

  for (const ticker of TICKERS) {
    try {
      const meta = await refreshOneTicker(ticker, env);
      results.push({ ticker, ok: true, key: meta.key });
      console.log(`[cron] ✅ ${ticker} -> ${meta.key}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      results.push({ ticker, ok: false, error: msg });
      console.log(`[cron] ❌ ${ticker}: ${msg}`);
    }
  }

  await env.LOGO_META.put("lastRun", ts);
  await env.LOGO_META.put("lastRunResult", JSON.stringify({ ts, results }));
  console.log("[cron] done");
}

async function refreshOneTicker(ticker: Ticker, env: Env): Promise<StoredMeta> {
  const apiKey = env.MASSIVE_API_KEY;

  // 1) Get branding URLs
  const overviewUrl = `https://api.massive.com/v3/reference/tickers/${ticker}?apiKey=${apiKey}`;
  const overviewRes = await fetch(overviewUrl);
  if (!overviewRes.ok) throw new Error(`Ticker overview failed (${overviewRes.status})`);

  const overviewJson = (await overviewRes.json()) as TickerOverviewResponse;
  const branding = overviewJson.results?.branding;

  const logoUrl = branding?.logo_url ? `${branding.logo_url}?apiKey=${apiKey}` : null;
  const iconUrl = branding?.icon_url ? `${branding.icon_url}?apiKey=${apiKey}` : null;

  if (!logoUrl && !iconUrl) throw new Error("No branding.logo_url or branding.icon_url");

  // 2) Fetch both (if present) and choose smaller by bytes
  const [logo, icon] = await Promise.all([
    logoUrl ? fetchImageBytes(logoUrl) : Promise.resolve(null),
    iconUrl ? fetchImageBytes(iconUrl) : Promise.resolve(null),
  ]);

  const chosen = chooseSmaller(logo, icon);
  if (!chosen) throw new Error("Both logo/icon fetch failed");

  // 3) Store bytes in R2 (raw, not data URI)
  const ext = mimeToExt(chosen.mime, chosen.url);
  const key = `logos/${ticker}.${ext}`;

  await env.LOGOS_CACHE.put(key, chosen.bytesBuf, {
    httpMetadata: { contentType: chosen.mime },
  });

  // 4) Store metadata in KV
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

  // fallback if content-type is missing/odd
  const lower = url.toLowerCase();
  if (lower.includes(".svg")) return "svg";
  if (lower.includes(".png")) return "png";
  if (lower.includes(".jpg") || lower.includes(".jpeg")) return "jpg";
  return "bin";
}
