# stock-prices
API Providers (optimized for free tier)
- finnhub for real time stock price
- Massive (polygon.io) for the ticker/symbol image
---
- This is meant for eventual deployment on cloudflare, with opennext (nextjs) as the framework
- Priority is ensuring every visitor doesn't call finnhub directly
    - visitors should still get relatively recent data across 10 tickers (used in this example)
---
# goal:
- send 10 stock tickers to get data from in 1 call
    - implement first in regular nextjs to understand and play around with APIs better
- send to cloudflare worker
- read from cloudflare worker
- consider Durable Objects and Workflows
---
created with ``pnpm create cloudflare@latest . --framework=next``
Massive install ``pnpm install --save '@massive.com/client-js'`` (didn't work)
- retried with ``pnpm add @massive.com/client-js``
    - build script warning left unfixed (do not select anything from) ``pnpm approve-builds`` yet
---
# env
.env.local has:
```
MASSIVE_API_KEY= # https://massive.com/dashboard
```