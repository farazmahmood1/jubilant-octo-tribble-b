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
| `npm run dev:worker` / `npm run start:worker` | Background worker (scheduler) from source with reload, or from `dist/` (Render worker) |
| `npm run job -- <name>` | Runs one job once and exits: 0 succeeded, 1 failed, 2 unknown job, 3 already running elsewhere |
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
| `POST /webhooks/shopify/:topic` | Shopify webhooks, HMAC-verified over the raw body; `:topic` is the topic with `-` for `/` |
| `GET /api/v1/integrations/status` | Which stores and PostEx accounts are configured. Never returns a credential |

## Layout

```
src/
  index.ts                  web service: start-up, graceful shutdown
  index.worker.ts           background worker: runs the job scheduler
  app.ts                    Express app: helmet, CORS, JSON, request logging, routes
  config.ts                 environment loading and validation (zod)
  logger.ts                 pino, with credentials redacted
  lib/                      money (paisa), Karachi time, phone normalisation
  jobs/                     job runner (lock, sync_runs, scheduler) and the job registry
  webhooks/                 Shopify webhook verification and processing
  gdpr/                     redaction for Shopify's GDPR webhooks
  domain/                   pure business rules: shipment-to-order matching, order state
  db.ts                     Neon connection (TLS required except on localhost), health check
  db/                       migration runner, migrations/NNNN_name.sql, seed from config
  db/repos/                 typed upserts and reads: products, variants (+ costs), customers, orders
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

## Shopify syncs

Two jobs fill the catalogue and the last 60 days of orders from both stores:

```bash
npm run job -- shopify:catalogue   # every product and variant; hourly on the worker
npm run job -- shopify:orders      # orders updated since the saved cursor; every 15 minutes
```

Each prints its stats as totals and per store (`nur.fetched`, `organics.inserted`, ...):
`fetched`, `inserted`, `updated`, `changed`, `skipped`, plus `unmappedSkus` (variants with no
SKU) and `unmappedLines` (order lines whose variant is not in the catalogue yet). Run the
catalogue first so order lines link to their variants.

The order cursor (`integration_cursors`, job `shopify:orders`) is the newest `updatedAt`
stored, saved after every page. A run that stops part-way resumes there; a second run re-reads
only the last 10 minutes and inserts nothing. Skipped items are logged by order name or variant
id only, never with customer data.

## Shopify webhooks

`POST /webhooks/shopify/<topic>` receives `orders/create`, `orders/updated`, `orders/cancelled`,
`fulfillments/create`, `fulfillments/update`, `refunds/create` and the three GDPR topics
(`customers/data_request`, `customers/redact`, `shop/redact`).

- **Signature.** Each delivery is verified with the store app's client secret
  (`SHOPIFY_CLIENT_SECRET` / `SHOPIFY_ORGANICS_CLIENT_SECRET`) over the raw bytes. The route has
  its own raw parser and is mounted before `express.json()`; a bad signature gets 401 and is
  logged without its body.
- **Once only.** Deliveries are stored in `webhook_events` keyed by `X-Shopify-Event-Id`, so a
  repeat is acknowledged and not processed again.
- **Fast answer.** The 200 is sent before processing. Order, fulfillment and refund events
  re-fetch the order through GraphQL and store it like the sync does.
- **GDPR.** Redaction scrubs names, phones, street addresses and postcodes from the tables and from
  the raw payloads, and is audited; a data request is queued for a person.
- **`shopify:catchup`** (every 15 minutes) processes stuck events, retries skipped orders from the
  review queue, and re-reads the last two hours of orders, which recovers a webhook Shopify never
  delivered.

**Registering them (done locally, per store):** in the Dev Dashboard app configuration, subscribe
each topic to `https://<public host>/webhooks/shopify/<topic with - for />`, e.g.
`/webhooks/shopify/orders-create`, and set the three compliance webhooks to
`/webhooks/shopify/customers-data_request`, `/webhooks/shopify/customers-redact` and
`/webhooks/shopify/shop-redact`. While the backend runs on localhost, the public host is a tunnel.

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
