# stock-prices
API Providers (optimized for free tier)
- finnhub for real time stock price
- Massive (polygon.io) for the ticker/symbol image
---
- This is meant for eventual deployment on cloudflare, with opennext (nextjs) as the framework
- Priority is ensuring every visitor doesn't call finnhub or polygon directly
    - visitors should still get relatively recent data across 10 tickers (used in this example)
- optimized to be as low-cost as possible (free cloudflare services, free, though limited API usage)
---
# goal:
- send 10 stock tickers to get data from in 1 call
    - implement first in regular nextjs to understand and play around with APIs better
- send to cloudflare worker
- read from cloudflare worker
- consider Durable Objects and Workflows
---
- created with ``pnpm create cloudflare@latest . --framework=next``
- polygon client added with ``pnpm add @massive.com/client-js`` (Massive's docs use OpenAPI spec - chose this because the .ts support is better using polygon client)
    - ``pnpm add axios``

---
# env
``workers/refresh-logos-cron/.dev.vars`` has:
```env
MASSIVE_API_KEY= # https://massive.com/dashboard
ADMIN_TOKEN= # Super long random token you make up
```
---
# Cloud changes
- R2 bucket ``logos-cache`` created
- Workers KV ``LOGO_META`` created
- Workers KV ``LOGO_META_preview`` created

---
# notes
### in ``workers/refresh-logos-cron``
- R2 remote CLI verification: ``pnpm dlx wrangler r2 object get logos-cache/test/scheduled.txt --remote``
- KV preview mode CLI verification``pnpm dlx wrangler kv key get lastRun --binding LOGO_META --preview``
- tested the worker with ``pnpm dlx wrangler dev --test-scheduled`` (wrangler cron was set to every 5 mins)