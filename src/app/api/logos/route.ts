import { getCloudflareContext } from "@opennextjs/cloudflare";

type StoredMeta = {
  ticker: string;
  key: string;
  mime: string;
  bytes: number;
  updated_at: string;
};

export async function GET(req: Request) {
  const { env } = getCloudflareContext();

  const tickers = (await env.LOGO_META.get("cfg:tickers", "json")) as string[] | null;
  if (!tickers || tickers.length === 0) {
    return Response.json(
      { error: "cfg:tickers missing. Run the cron Worker once to populate it." },
      { status: 500 }
    );
  }

  const lastRun = await env.LOGO_META.get("lastRun");
  const etag = lastRun ? `"${lastRun}"` : null;

  if (etag) {
    const inm = req.headers.get("if-none-match");
    if (inm && inm === etag) return new Response(null, { status: 304 });
  }

  const logos: Array<{
    ticker: string;
    dataUri: string;
    updated_at: string;
    mime: string;
    bytes: number;
  }> = [];

  for (const t of tickers) {
    const ticker = t.toUpperCase();

    const meta = (await env.LOGO_META.get(`ticker:${ticker}`, "json")) as StoredMeta | null;
    if (!meta) continue;

    const obj = await env.LOGOS_CACHE.get(meta.key);
    if (!obj) continue;

    // R2 object bodies support arrayBuffer() [web:9]
    const ab = await obj.arrayBuffer();

    // nodejs_compat is enabled in your root wrangler config, so Buffer is available [web:188]
    const b64 = Buffer.from(ab).toString("base64");
    const dataUri = `data:${meta.mime};base64,${b64}`;

    logos.push({
      ticker,
      dataUri,
      updated_at: meta.updated_at,
      mime: meta.mime,
      bytes: meta.bytes,
    });
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("Cache-Control", "public, max-age=3600");
  if (etag) headers.set("ETag", etag);

  return new Response(JSON.stringify({ lastRun, logos }), { status: 200, headers });
}
