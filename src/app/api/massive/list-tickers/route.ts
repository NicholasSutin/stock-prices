import { restClient } from '@massive.com/client-js';

const apiKey = process.env.MASSIVE_API_KEY!;;
const rest = restClient(apiKey, 'https://api.massive.com');

async function example_listTickers() {
  try {
    const response = await rest.listTickers(
      {
        ticker: "GOOGL",
        market: "stocks",
        active: "true",
        order: "asc",
        limit: "100",
        sort: "ticker"
      }
    );
    console.log('Response:', response);
  } catch (e) {
    console.error('An error happened:', e);
  }
}

example_listTickers();

{/*
    
    import { restClient } from '@massive.com/client-js';

export const runtime = 'edge';

export async function GET() {
  const apiKey = process.env.MASSIVE_API_KEY!;
  const rest = restClient(apiKey, 'https://api.massive.com');

  const response = await rest.listTickers({
    ticker: "GOOGL",
    market: "stocks",
    active: "true",
    order: "asc",
    limit: "100",
    sort: "ticker",
  });

  return Response.json(response);
}


    */}