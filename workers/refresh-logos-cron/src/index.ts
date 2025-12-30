import { getCloudflareContext } from "@opennextjs/cloudflare";

type StoredMeta = {
  ticker: string;
  key: string;
  mime: string;
  bytes: number;
  updated_at: string;
};

export async function GET() {
  try {
    // Important: use async mode so bindings work reliably in route handlers.
    const { env } = await getCloudflareContext({ async: true });

    const tickers = (await env.LOGO_META.get("cfg:tickers", "json")) as string[] | null;
    if (!tickers || tickers.length === 0) {
      return Response.json({ error: "cfg:tickers missing or empty" }, { status: 500 });
    }

    const logos: Array<{
      ticker: string;
      dataUri: string;
      updated_at: string;
      mime: string;
      bytes: number;
      key: string;
    }> = [];

    for (const t of tickers) {
      const ticker = t.toUpperCase();

      const meta = (await env.LOGO_META.get(`ticker:${ticker}`, "json")) as StoredMeta | null;
      if (!meta) continue;

      const obj = await env.LOGOS_CACHE.get(meta.key);
      if (!obj) continue;

      const ab = await obj.arrayBuffer();
      const b64 = Buffer.from(ab).toString("base64");
      const dataUri = `data:${meta.mime};base64,${b64}`;

      logos.push({
        ticker,
        dataUri,
        updated_at: meta.updated_at,
        mime: meta.mime,
        bytes: meta.bytes,
        key: meta.key,
      });
    }

    return Response.json({ tickers, logos });
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
    return new Response(msg, { status: 500, headers: { "Content-Type": "text/plain" } });
  }
}
