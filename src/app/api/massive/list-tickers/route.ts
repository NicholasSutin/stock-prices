import { restClient } from '@massive.com/client-js';

export const runtime = 'edge';

export async function GET() {
  const apiKey = process.env.MASSIVE_API_KEY!;
  const rest = restClient(apiKey, 'https://api.massive.com');

  // Minimal params - let others default
  const response = await rest.listTickers({
    ticker: "GOOGL",
  });

  return Response.json(response);
}
