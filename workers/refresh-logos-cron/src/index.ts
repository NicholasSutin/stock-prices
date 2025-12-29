type Env = {
  LOGO_META: KVNamespace;
  LOGOS_CACHE: R2Bucket;
  MASSIVE_API_KEY: string;  // Add this line
};

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runOnce(env));
  },

  // Keep a simple fetch route for sanity checks while iterating
  async fetch(_req: Request, env: Env) {
    const lastRun = await env.LOGO_META.get("lastRun");
    return new Response(lastRun ? `ok (lastRun=${lastRun})` : "ok (no lastRun yet)");
  },
};

async function runOnce(env: Env) {
  const ts = new Date().toISOString();
  console.log("[scheduled] start", ts);

  // Test secret load (local from .dev.vars, prod from wrangler secret)
  console.log("Secret:", env.MASSIVE_API_KEY ? "✅ loaded" : "❌ missing");

  try {
    await env.LOGOS_CACHE.put("test/scheduled.txt", `ran at ${ts}`, {
      httpMetadata: { contentType: "text/plain" },
    });
    console.log("[scheduled] ✅ wrote R2 test/scheduled.txt");
  } catch (err) {
    console.log("[scheduled] ❌ R2 put failed", err);
    throw err;
  }

  try {
    await env.LOGO_META.put("lastRun", ts);
    console.log("[scheduled] ✅ wrote KV lastRun");
  } catch (err) {
    console.log("[scheduled] ❌ KV put failed", err);
    throw err;
  }

  console.log("[scheduled] done");
}
