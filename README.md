# NUR Organics platform — backend

Node.js + Express + TypeScript service behind the order, returns, inventory and profit platform.
It connects two Shopify stores (NUR by Juggun, Juggun's Organics) and the PostEx COD accounts,
and serves the dashboard from its own PostgreSQL database on Neon.

## Running it

```bash
npm install
cp .env.example .env     # values already in the repo-root .env are picked up automatically
npm run dev              # http://localhost:4000, restarts on change
npm run verify           # read-only connection check for Neon, Shopify and PostEx
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server with reload |
| `npm run build` / `npm start` | Compile to `dist/` and run it (used on Render) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run verify` | Checks every configured integration, read-only |

## Configuration

`backend/.env` is read first, then the repo-root `.env`, so credentials live in one place.
Blank values count as unset. See `.env.example` for the full list.

Each brand has its own Shopify store and PostEx account, so config holds lists rather than single
values: `SHOPIFY_*` and `POSTEX_TOKEN` for NUR by Juggun, `SHOPIFY_ORGANICS_*` and
`POSTEX_ORGANICS_TOKEN` for Juggun's Organics.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness: the process is up |
| `GET /ready` | Readiness: database reachable (503 when it is not) |
| `GET /api/v1/integrations/status` | Which stores and PostEx accounts are configured. Never returns a credential |

## Layout

```
src/
  index.ts                  start-up, graceful shutdown
  app.ts                    Express app: helmet, CORS, JSON, request logging, routes
  config.ts                 environment loading and validation (zod)
  logger.ts                 pino, with credentials redacted
  db.ts                     Neon connection, health check
  http/routes/              health, integrations status
  http/middleware/errors.ts 404 and error handling
  integrations/postex/      read-only PostEx client + verified response types
  integrations/shopify/     Admin GraphQL client, 24-hour token cache
  scripts/verify.ts         read-only connection check
```

## Rules this code follows

- **PostEx is read-only.** There is no method that books, cancels or advises on a parcel, because
  PostEx has no test environment; a mistake would move real parcels and real money.
  `POSTEX_ALLOW_WRITES` cannot be turned on outside production.
- **One request per second per PostEx account**, since PostEx publishes no rate limits. Failures
  retry with backoff; 4xx responses do not retry, because they mean a bad request or a bad token.
- **PostEx field names come from the live API**, not the v4.1.9 PDF: `invoicePayment` (COD),
  `transactionFee`/`transactionTax` (delivery charge), `reversalFee`/`reversalTax` (return charge).
- **Status labels differ between PostEx endpoints** ("Return" vs "Returned"), so raw values are
  stored and the history message codes are the reliable signal.
- **Shopify tokens** come from the client credentials grant and last 24 hours; they are cached and
  refreshed 5 minutes early. Requests back off using the cost figures Shopify returns.
- **Credentials never reach the logs.**

## Next steps

The step-by-step plan for all eight modules, with a "done when" for each step, is in
[`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md).
