import { NextResponse } from 'next/server';

export const runtime = 'edge';

// Ticker list lives here (NOT in page.tsx)
const TICKERS = ['META', 'AAPL', 'AMZN', 'MSFT', 'GOOGL'] as const;

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

type LogoChoice = {
  ticker: Ticker;
  ok: boolean;
  mime: string | null;
  bytes: number | null;
  data_uri: string | null;
  // Optional debug info (useful while stabilizing)
  source_url?: string | null;
  error?: string;
};

type ApiResponse = {
  tickers: readonly Ticker[];
  generated_at: string;
  data: LogoChoice[];
};

// 1 day cache for successful full payload
const CACHE_OK = 'public, max-age=86400, s-maxage=86400';
// 1 minute cache for partial/failed payload so unresolved tickers retry frequently
const CACHE_RETRY = 'public, max-age=60, s-maxage=60';

export async function GET() {
  const apiKey = process.env.MASSIVE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'MASSIVE_API_KEY is not set' }, { status: 500 });
  }

  const results: LogoChoice[] = [];
  let hasAnyFailure = false;

  for (const ticker of TICKERS) {
    const row = await fetchBestLogoDataUri(ticker, apiKey);
    if (!row.ok) hasAnyFailure = true;
    results.push(row);
  }

  const payload: ApiResponse = {
    tickers: TICKERS,
    generated_at: new Date().toISOString(),
    data: results,
  };

  return NextResponse.json(payload, {
    headers: {
      'Cache-Control': hasAnyFailure ? CACHE_RETRY : CACHE_OK,
    },
  });
}

async function fetchBestLogoDataUri(ticker: Ticker, apiKey: string): Promise<LogoChoice> {
  try {
    const overviewUrl = `https://api.massive.com/v3/reference/tickers/${ticker}?apiKey=${apiKey}`;
    const overviewRes = await fetch(overviewUrl);

    if (!overviewRes.ok) {
      return {
        ticker,
        ok: false,
        mime: null,
        bytes: null,
        data_uri: null,
        source_url: null,
        error: `Ticker overview failed (${overviewRes.status})`,
      };
    }

    const overviewJson = (await overviewRes.json()) as TickerOverviewResponse;
    const branding = overviewJson.results?.branding;

    const logoUrl = branding?.logo_url ? `${branding.logo_url}?apiKey=${apiKey}` : null;
    const iconUrl = branding?.icon_url ? `${branding.icon_url}?apiKey=${apiKey}` : null;

    if (!logoUrl && !iconUrl) {
      return {
        ticker,
        ok: false,
        mime: null,
        bytes: null,
        data_uri: null,
        source_url: null,
        error: 'No branding.logo_url or branding.icon_url',
      };
    }

    // Fetch both (if present), choose smaller by byte length
    const [logo, icon] = await Promise.all([
      logoUrl ? fetchImageBytes(logoUrl) : Promise.resolve(null),
      iconUrl ? fetchImageBytes(iconUrl) : Promise.resolve(null),
    ]);

    const chosen = chooseSmaller(logo, icon);

    if (!chosen) {
      return {
        ticker,
        ok: false,
        mime: null,
        bytes: null,
        data_uri: null,
        source_url: null,
        error: 'Both logo/icon fetch failed',
      };
    }

    return {
      ticker,
      ok: true,
      mime: chosen.mime,
      bytes: chosen.bytes,
      data_uri: toDataUri(chosen.mime, chosen.bytesBuf),
      source_url: chosen.url,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return {
      ticker,
      ok: false,
      mime: null,
      bytes: null,
      data_uri: null,
      source_url: null,
      error: msg,
    };
  }
}

type FetchedImage = {
  url: string;
  mime: string;
  bytes: number;
  bytesBuf: Uint8Array;
};

async function fetchImageBytes(url: string): Promise<FetchedImage | null> {
  const res = await fetch(url);
  if (!res.ok) return null;

  const mime = res.headers.get('content-type') || inferMimeFromUrl(url);
  const ab = await res.arrayBuffer();
  const u8 = new Uint8Array(ab);

  return {
    url,
    mime,
    bytes: u8.byteLength,
    bytesBuf: u8,
  };
}

function chooseSmaller(a: FetchedImage | null, b: FetchedImage | null): FetchedImage | null {
  if (a && b) return a.bytes <= b.bytes ? a : b;
  return a ?? b ?? null;
}

function inferMimeFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes('.svg')) return 'image/svg+xml';
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.jpg') || lower.includes('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function toDataUri(mime: string, bytes: Uint8Array): string {
  // Convert bytes -> base64 in an edge-safe way
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return `data:${mime};base64,${base64}`;
}
