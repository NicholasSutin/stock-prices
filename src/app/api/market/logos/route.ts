import { NextResponse } from 'next/server';

export const runtime = 'edge';

// MASTER TICKER LIST
const TICKERS = ["META", "AAPL", "AMZN", "MSFT", "GOOGL", "TSLA", "NVDA"];

export async function GET() {
  // Return the list of tickers and their corresponding proxy URLs
  // We don't fetch the images here (to avoid timeouts/limits).
  // The browser will fetch each image individually via the proxy.
  const data = TICKERS.map(ticker => ({
    ticker,
    // Point to our persistent proxy route
    logo_src: `/api/logo/${ticker}`
  }));

  return NextResponse.json({ data });
}
