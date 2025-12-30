import { getCloudflareContext } from "@opennextjs/cloudflare";

type Ctx = { params: Promise<{ ticker: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { ticker } = await params;
  const t = ticker.toUpperCase();

  const { env } = getCloudflareContext();

  const meta = await env.LOGO_META.get(`ticker:${t}`, "json") as
    | { key: string; mime: string; updated_at?: string }
    | null;

  if (!meta) return new Response("not found", { status: 404 });

  const obj = await env.LOGOS_CACHE.get(meta.key);
  if (!obj || !obj.body) return new Response("not found", { status: 404 });

  // Preserve browser caching if you want (simple ETag)
  const etag = meta.updated_at ? `"${meta.updated_at}"` : null;
  if (etag) {
    const inm = req.headers.get("if-none-match");
    if (inm && inm === etag) return new Response(null, { status: 304 });
  }

  const headers = new Headers();
  headers.set("Content-Type", meta.mime);
  headers.set("Cache-Control", "public, max-age=86400");
  if (etag) headers.set("ETag", etag);

  return new Response(obj.body, { status: 200, headers });
}
