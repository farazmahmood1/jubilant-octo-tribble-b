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
| `npm run postex:totals -- <from> <to>` | PostEx parcels, delivered, returned and charges per account for a Karachi booking window |
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
  domain/                   business rules: shipment-to-order matching, order state, stock ledger
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
npm run job -- shopify:orders      # orders updated since the saved cursor; hourly on the worker
```

Each prints its stats as totals and per store (`nur.fetched`, `organics.inserted`, ...):
`fetched`, `inserted`, `updated`, `changed`, `skipped`, plus `unmappedSkus` (variants with no
SKU) and `unmappedLines` (order lines whose variant is not in the catalogue yet). Run the
catalogue first so order lines link to their variants.

The order cursor (`integration_cursors`, job `shopify:orders`) is the newest `updatedAt`
stored, saved after every page. A run that stops part-way resumes there; a second run re-reads
only the last 10 minutes and inserts nothing. Skipped items are logged by order name or variant
id only, never with customer data.

### Cost per item and stock from Shopify

The catalogue sync also reads each variant's **Cost per item** and its stock per Shopify
location (read_inventory, read_locations):

- **Costs** go into `product_costs` only when Shopify's cost changes, so an unchanged catalogue
  adds nothing. A variant's first cost, when it has none at all, is taken back to the start of
  the synced history (`costs` setting `shopifyFirstEffectiveFrom`, default `2026-01-01`) so the
  parcels already delivered can be costed; later changes take effect the day they are seen. A
  dated cost entered by a person always wins for its dates. A new cost closes the
  `cost_missing` items it answers and re-posts the COGS it unblocks. An empty or zero cost is
  "not entered" (counted as `noCost`).
- **Stock levels** are kept in `shopify_stock_levels` as Shopify reports them. They are compared
  with, never written into, our ledger.

**Shopify's "on hand" is not the shelf.** The team ships through PostEx and does not mark orders
fulfilled, so parcels that have left stay "committed" and "on hand" in Shopify. The Inventory
page's *Shopify stock* card shows, per product: on hand, committed, how much of that is on orders
not booked yet, available, the **shelf estimate** (available + committed to unbooked orders),
our warehouse, and the difference. *Use the shelf estimate as the opening count* (once per store)
records an opening stock count dated at the cut-over day that makes our warehouse today equal the
estimate (`GET /api/v1/stock/shopify-comparison`, `POST /api/v1/stock/opening-from-shopify`).

## PostEx sync

`npm run job -- postex:sync` (every 15 minutes on the worker, see *Worker schedule*) does four
things per account, read-only (PostEx has no write call anywhere in this code):

1. **Find new parcels.** `get-all-order` from the account's cursor (minus 3 days) to today, in
   31-day chunks, at most every 15 minutes. The first run starts from 1 January 2026.
2. **Refresh what is due**, 25 parcels per `track-bulk-order` call, by tier: new parcels now; out
   for delivery or attempted every 5 minutes; other open parcels every 15 minutes; open parcels
   booked over 30 days ago daily; delivered, returned or cancelled in the last 7 days daily (late
   fee corrections); older terminal parcels never.
3. **Link parcels to orders** with the matcher: first by the tracking number the "Book at
   PostEx" app writes in the order's note ("…shipped via PostEx with Tracking 2854…"; only the
   numbers are kept, in `orders.postex_tracking_numbers`), then by order number (store prefixes from the
   `matching` setting, e.g. `{"refPrefixes": {"nur": ["NBJ"]}}`), else by COD amount and city,
   else by phone, within 3 days of booking and only on a single candidate. A fallback link opens
   an info `match_suggested` item; a parcel with no link has an open `unmatched_shipment` item
   with the reason, resolved when a later run finds the order. A manual link is never changed.
4. **Move stock** for every parcel whose status or order link changed (see *Stock ledger*).

History steps are inserted with the unique `(shipment, code, time)` key doing the dedupe, so a
re-run adds no rows. A parcel's status, attempts and last failure reason are derived from all its
stored steps, in event-time order. An unknown status code is reported once to the review queue.

`npm run job -- postex:payouts` (daily) asks PostEx's payment status for delivered parcels not
yet on a payout, oldest first, up to 600 per account per run. A settled parcel is recorded under
its CPR in `cod_payouts`, with a `payout_lines` row worth its COD less the forward charge and
tax; the payout's amount is the sum of its lines.

To reconcile after a sync: `npm run postex:totals -- 2026-05-14 2026-09-19` and compare with
877 delivered, 117 returned, PKR 209,009 forward and PKR 27,787 return charges (fees and their
16% tax are shown apart).

## Stock ledger

Stock is a ledger (`stock_moves`), never a number: every move has a from and a to location
(warehouse, partner, in transit, returning, customer, marketing, damaged, supplier, adjustment),
and `stock_quants` is kept by a trigger on the ledger and can be recomputed with
`rebuildQuants()`. A parcel's units follow its PostEx history: booked leaves the warehouse for in
transit; delivered goes to customer (marketing for a PR order); return started or returned (0040,
0006) goes to returning; cancelled by merchant (0002) goes back to the warehouse. 0006 moves
nothing further: only a person checking the parcel in (`checkInReturn`, restocked or damaged)
does, and `returnsAwaitingCheckIn()` lists the parcels PostEx has returned that nobody has
checked in. Counts and corrections go through `recordAdjustment()`, against the adjustment
location, and are audited. Order lines with no catalogue variant cannot move and are queued.

## Reconciliation queue

`reconciliation:scan` (hourly) checks every parcel against the five Step 9 rules in
`src/domain/reconciliation.ts` and keeps `reconciliation_items` equal to what they find:
unmatched parcel, COD different from what the order should collect (nothing on a paid order),
possible duplicate booking (two live parcels for one order), stuck in transit (no status change
for `alerts.stuckDays`, default 7, Karachi days) and unknown PostEx status code. A re-run adds
nothing; an item a person resolved or ignored is never reopened; an item whose condition clears
is closed by the system. Every close is in `audit_log`.

API (signed in): `GET /api/v1/reconciliation/items?status=&kind=&store=&before=&limit=`,
`GET /api/v1/reconciliation/summary`, `POST .../items/:id/resolve` and `.../ignore` with a
`note`, `GET .../items/:id/candidates` and `POST .../items/:id/link` with `orderId` or
`orderNumber`. A link updates the parcel, closes its items, moves its stock and sets its order's
state in one transaction.

Stock API: `GET /api/v1/stock/returns-awaiting`, `POST /api/v1/stock/returns/:shipmentId/check-in`
(`restocked` or `damaged`), `GET /api/v1/stock/locations`, `GET /api/v1/stock/quants`,
`GET /api/v1/stock/variants?search=`, `POST /api/v1/stock/adjustments`.

**Matching prefixes.** `npm run match:report` prints, per PostEx account, the match rate against
the 4.6% target, any unmatched parcel without a queue row, and every order-number prefix seen on
parcels, marking the ones the `matching` setting does not accept yet. Set them with
`PUT /api/v1/settings/matching` (`{"refPrefixes": {"nur": ["NBJ"], "organics": []}}`) or from the
dashboard's Reconciliation page; the next `postex:sync` re-tries every unmatched parcel.

## Order state

`orders.state` is written only by `recomputeOrderState()`, after a Shopify order is stored and
after a parcel's status or order link changes; every change is logged in `order_state_log` with
its reason. Until the Confirmation Desk exists, confirmation comes from the Shopify tags the
teams use, compared by their words (emoji and case ignored): `Order Confirmed`, `COD-Confirmed`;
`Order Canceled`; `Confirmation Pending`, `COD-Needs-Review`; `didnt answer the call`, `call not attended`, `didnt confirm`
(no answer); `number off`, `No Phone`, `NO WhatsApp` (unreachable). "On hold" is Shopify's own
fulfillment status, not a tag. Change the list with `GET|PUT /api/v1/settings/confirmation-tags`,
then run `npm run orders:states` to re-derive every order.

## Accounting

Double-entry, in `journal_entries` and `journal_lines` (migration `0007_accounting.sql`, one
seeded chart for both brands with the brand on each line). The database refuses an entry whose
debits and credits differ, at commit; entries are never edited, a correction is a reversal.
`src/domain/accounting.ts` has the posting rules (Step 10 table, with notes S10–S13):

- **Delivered** (the only place revenue is recognised): COD receivable / sales revenue and tax
  payable, and the cost of the units that left: COGS (marketing for a PR order) / inventory.
- **PostEx charges** post as PostEx reports them, delivered or not: delivery or return expense,
  plus the 16% tax (expensed until the accountant says to claim it: `accounting` setting
  `claimPostexInputTax`) / COD receivable. A corrected fee is reversed and re-posted.
- **Returned after delivery**: the sale and COGS are reversed, dated by the return; both charges
  stay. **Refused**, never delivered: there was no sale, so only the charges post.
- **COD payout**: bank / COD receivable, per payout line. **Damaged return**: write-off / inventory.
- Vendor bills and payments, consignment sales and partner payments have posting functions for
  when their screens land.

`postex:sync` posts whatever changed (`accounting_pending`, set in the same transaction as the
change); `postex:payouts` posts each payout. A missing product cost opens a `cost_missing`
item and holds that COGS back. `npm run accounting:replay` re-posts anything missing for every
parcel and payout and prints the trial balance (exit 1 if it does not balance).

**Month close.** `closePeriod()` closes a month from the 5th of the next one, in order (an
earlier month with entries must be closed first); after that the database refuses any entry
dated in it, with the reason. Syncs date a late event on the first day of the next open month
instead, saying so in the memo.

**Opening balances.** Entered on the balance-sheet accounts as at one date; whatever does not
balance is the owner's opening equity (3100), so a partial list still posts and the gap shows.
Re-entering them reverses the earlier entry while that month is open.

**Checking the opening figures** (Accounting page, or the API below):

1. **Pick the cut-over date: the day before the first parcel in the system** (the PostEx history
   starts in May 2026). Everything after it is posted from the syncs; the client's books cover
   everything before it. The opening balances card warns if any entry is dated on or before it,
   because that history would be counted twice.
2. **Get the client's balance sheet as at that day** from their accountant: bank balance (match
   the bank statement), money PostEx held for them (COD collected, not yet paid out: the PostEx
   portal or the last statement), supplier balances owed, sales tax owed, consignment owed by
   partners, and the stock value. Enter them on the card. A gap shows up in 3100 Opening balances:
   ask the accountant what it is before the first month closes.
3. **Count the stock as at the same day** and enter it on the Inventory page as *Opening stock*,
   "counted as at" that date (only an opening count can be dated back). Enter each product's cost
   effective on or before that date.
4. **Run the Inventory check for that date.** It compares the Inventory account (1300) with
   units × cost and must say *Agrees*. If not: products with no cost are listed (enter the
   cost), products below zero were sold before the count was entered, and any remaining
   difference means the client's stock value and their count disagree.
5. **Compare the trial balance as at that date** with the client's balance sheet, line by line.

API (signed in; amounts are integer paisa in strings): `GET /api/v1/accounting/inventory-check?asAt=`,
`GET /api/v1/accounting/trial-balance?to=&store=`,
`GET /api/v1/accounting/accounts/:code/lines`, `GET /api/v1/accounting/periods`,
`POST /api/v1/accounting/periods/:year/:month/close`, `GET|PUT /api/v1/accounting/opening-balances`.
The dashboard's Accounting page uses them.

## Worker schedule

Neon suspends its compute when nothing queries it, so the jobs are timed to wake it as rarely as
possible (risk R3, note S4): `postex:sync` and `shopify:catchup` run together on the quarter hour,
the hourly jobs on the hour, and `postex:payouts` daily. Only while a parcel is out for delivery
or has a failed attempt does `postex:sync` ask for 5 minutes. From 23:00 to 08:00 Karachi
everything runs at most hourly.

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
