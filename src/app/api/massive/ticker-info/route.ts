import { 
  restClient, 
  GetStocksAggregatesTimespanEnum, 
  GetStocksAggregatesSortEnum 
} from '@massive.com/client-js';

// Use edge runtime for better performance on Vercel/Next.js
export const runtime = 'edge';

export async function GET() {
  // 1. Validation: Ensure API key exists before initialization
  if (!process.env.MASSIVE_API_KEY) {
    throw new Error('MASSIVE_API_KEY is not defined');
  }

  // 2. Initialization:
  // - Use explicit base URL 'https://api.massive.com' to match the new API rebrand
  // - Pass the API key directly
  const rest = restClient(process.env.MASSIVE_API_KEY, 'https://api.massive.com');

  try {
    // 3. Data Fetching:
    // - Method Name: 'getStocksAggregates' (Flat structure, NOT rest.stocks.aggregates)
    // - Params: Must use object-based parameters for this client version
    // - Enums: 'timespan' and 'sort' require strictly typed Enums, not raw strings
    const response = await rest.getStocksAggregates({
      stocksTicker: "AAPL", 
      multiplier: 1, 
      timespan: GetStocksAggregatesTimespanEnum.Day, // Enums required by TypeScript
      from: "2025-11-01",
      to: "2025-11-30",
      adjusted: true,
      sort: GetStocksAggregatesSortEnum.Asc,         // Enums required by TypeScript
      limit: 120
    });

    // 4. Success Response
    console.log('Massive API Response:', response);
    return Response.json(response);

  } catch (e: any) {
    // 5. Error Handling
    console.error('Massive API Error:', e);
    return Response.json(
      { error: e.message || 'An error occurred fetching stock data' }, 
      { status: 500 }
    );
  }
}
