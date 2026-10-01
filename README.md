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
| `npm run build` / `npm start` | Clean `dist/`, compile, copy migrations into it; then run it (used on Render) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run verify` | Checks every configured integration, read-only |
| `npm test` / `npm run test:watch` | `node:test` over `src/**/*.test.ts`, once or on change |
| `npm run migrate` | Applies pending migrations from `src/db/migrations/`; refuses if an applied file changed |
| `npm run migrate:status` | Applied, pending, changed or missing, per migration; exits 1 on changed or missing |
| `npm run migrate:prod` | Same as `migrate`, from the compiled build, without `tsx` |
| `npm run seed` | Upserts `stores` and `postex_accounts` from config; safe to repeat |

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
| `GET /ready` | Readiness: database reachable and every migration applied unchanged (503 otherwise) |
| `GET /api/v1/integrations/status` | Which stores and PostEx accounts are configured. Never returns a credential |

## Layout

```
src/
  index.ts                  start-up, graceful shutdown
  app.ts                    Express app: helmet, CORS, JSON, request logging, routes
  config.ts                 environment loading and validation (zod)
  logger.ts                 pino, with credentials redacted
  lib/                      money (paisa), Karachi time, phone normalisation
  domain/                   pure business rules: shipment-to-order matching
  db.ts                     Neon connection (TLS required except on localhost), health check
  db/                       migration runner, migrations/NNNN_name.sql, seed from config
  http/routes/              health, integrations status
  http/middleware/errors.ts 404 and error handling
  integrations/postex/      read-only PostEx client + verified response types
  integrations/shopify/     Admin GraphQL client, 24-hour token cache
  scripts/verify.ts         read-only connection check
  test/                     fixture loader, PII masking, DB test schemas, fixtures/<source>/
```

## Database on start-up

`npm run dev` and `npm start` apply pending migrations and seed `stores` and `postex_accounts`
from config before serving. Both steps are idempotent and lock-protected, so the web service and
the worker can start together. If an applied migration was edited, the process refuses to start.
Set `DB_MIGRATE_ON_BOOT=false` to manage the schema by hand with `npm run migrate`.

## Tests and fixtures

Tests sit next to the code as `*.test.ts` and run with `node:test` through `tsx`, so there is no
build step and no test framework dependency.

Database tests run only when `DATABASE_URL_TEST` points at a scratch Postgres, and are skipped
otherwise. Each test gets its own schema, dropped afterwards. Never point it at Neon; the helper
refuses a `*.neon.tech` host.

```bash
docker run --rm -d -e POSTGRES_PASSWORD=x -p 5433:5432 postgres:17
DATABASE_URL_TEST=postgres://postgres:x@localhost:5433/postgres npm test
```

Fixtures in `src/test/fixtures/` are **recorded real responses**, because PostEx has no sandbox
and its field names differ from its own documentation. Two rules:

- Pass every recording through `maskPii()` (`src/test/mask-pii.ts`) before saving it. It replaces
  names, phones, addresses and emails at any depth and keeps what matching needs: order names,
  tracking numbers, cities, amounts. Read the file before committing it anyway.
- Name files `<source>-<endpoint>-<case>.json`, e.g. `postex-track-order-delivered.json` or
  `shopify-orders-cancelled.json`, in a folder per source (`fixtures/postex/`,
  `fixtures/shopify/`), and load them with `fixture('postex-track-order-delivered')`. The loader
  rejects names that break the pattern.

**The PostEx fixtures are synthetic for now.** They are built from the verified field names and
carry a `_fixture` note saying so. Replace each with a masked recording of the same name; the
mapper tests then run against real data with no code change.

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
