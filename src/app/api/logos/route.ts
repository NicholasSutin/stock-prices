export async function GET() {
  const base = process.env.LOGO_WORKER_BASE_URL;
  const token = process.env.LOGO_WORKER_ADMIN_TOKEN;

  if (!base || !token) {
    return Response.json({ error: "Missing LOGO_WORKER_BASE_URL or LOGO_WORKER_ADMIN_TOKEN" }, { status: 500 });
  }

  const res = await fetch(`${base}/manifest`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const json = await res.json();
  return Response.json(json, { status: res.status });
}
