import { headers } from "next/headers";

type Logo = { ticker: string; dataUri: string; updated_at: string; mime: string; bytes: number };
type LogosResponse = { lastRun: string | null; logos: Logo[] };

export default async function Logos() {
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  if (!host) return <div>Missing host header</div>;

  const res = await fetch(`${proto}://${host}/api/logos`, { cache: "no-store" });

  if (!res.ok) {
    const text = await res.text();
    return (
      <div>
        <div>Failed to load /api/logos: {res.status}</div>
        <pre style={{ whiteSpace: "pre-wrap" }}>{text}</pre>
      </div>
    );
  }

  const data = (await res.json()) as LogosResponse;

  if (data.logos.length === 0) {
    return <div>No cached logos yet. Run /__scheduled a few times.</div>;
  }

  return (
    <div>
      {data.logos.map((l) => (
        <div key={l.ticker}>
          <div>{l.ticker}</div>
          <img src={l.dataUri} alt={l.ticker} width={32} height={32} />
        </div>
      ))}
    </div>
  );
}
