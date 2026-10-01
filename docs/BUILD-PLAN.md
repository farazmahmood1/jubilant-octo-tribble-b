# NUR Organics Platform — Build Plan

Reference: proposal CDL-NUR-2026-09 (8 modules, 4 weeks).
Owner: Codilated. Target: both Shopify stores + both PostEx accounts, one database, one dashboard.

This plan is the working document. Each step is a commit-sized unit with an explicit "done when".

Repos: `backend/` is this repository (`jubilant-octo-tribble-b`), `frontend/` is `scaling-guide`.

---

## 0. Where we are today

Working:

- `backend/` — Express 5 + TS strict, layered env config, pino, postgres.js on Neon, JWT auth, `/auth/login`, `/auth/me`, `/integrations/status`, `/integrations/health`, read-only PostEx client, Shopify client-credentials client.
- `frontend/` — Vite + React 19 + Tailwind v4 + shadcn, login page, app shell, connection health card.
- All four integrations verified green: Nur By Juggun (PKR, 6 scopes), Juggun's Organics (PKR, 6 scopes), both PostEx accounts.

Not started: database schema, any sync, any business module.

Hosting as of 1 October 2026: the frontend is deployed on **Vercel**
(`https://scaling-guide-flame.vercel.app`), not a Render static site. The backend runs on
localhost until the client shares the Render keys. Until then the Vercel site cannot reach an
API; development uses the local frontend (`npm run dev`) against the local backend.

Everything below assumes PostEx stays **read-only**. No booking, no cancelling, no shipper advice. That is a scope exclusion in the proposal and a safety rule in the code.

---

## 1. Design decisions to settle before writing tables

These are decided now so nothing has to be unpicked in week 3.

### 1.1 Money

All money is stored as **integer paisa** (`bigint`), never float. Currency is PKR everywhere; a `currency` column exists but is constant for now. Format only at the edge.

### 1.2 Time

Store `timestamptz` in UTC. Display and all business-day logic (month close, payout ageing, "confirmed but not booked within a day") use **Asia/Karachi**. One helper does the conversion, never inline.

PostEx returns local strings without an offset. Parse them as Asia/Karachi explicitly, once, in the PostEx mapper.

### 1.3 The three streams stay separate

The proposal's core promise. Never collapse them into one status column:

| Stream | Where it lives | Source of truth |
|---|---|---|
| Parcel | `shipments` + `shipment_events` | PostEx |
| Money | `journal_entries` + `cod_payouts` | Platform, fed by PostEx + accounting |
| Stock | `stock_moves` | Platform |

An order row carries a derived `state`, computed from the three, never written by hand.

### 1.4 Stock is a ledger, not a number

No `quantity` column that gets incremented. Every movement is a row in `stock_moves` with a **from location** and a **to location**, mirroring double-entry. Current stock is `SUM(in) - SUM(out)` per (variant, location), materialised into `stock_quants` for speed and rebuildable from scratch at any time.

Location types:

- `warehouse` — the central warehouse (one row, expandable)
- `partner` — one per retail/grocery partner (consignment; still your stock)
- `in_transit` — with PostEx, dispatched, outcome unknown
- `returning` — PostEx has started the return, not yet physically received
- `customer` — sold and delivered (terminal sink)
- `marketing` — PR packages (terminal sink, expensed not sold)
- `damaged` — returned unfit (terminal)
- `supplier` — source for goods receipts
- `adjustment` — counterpart for counts and corrections

Every move is `(variant, qty, from_location, to_location, reason, ref_type, ref_id, actor, occurred_at)`. Stock can never appear or vanish without a counterpart location. This is what makes "no return silently lost" provable rather than aspirational.

### 1.5 Accounting is double-entry

`journal_entries` (header) + `journal_lines` (account, debit, credit) with a hard constraint that lines balance. Everything financial posts here: delivered sale, COGS, PostEx forward charge, PostEx return charge and its tax, payout receipt, vendor bill, partner invoice, PR marketing expense. Reports (GL, TB, Partner Ledger, P&L) are queries over this, never bespoke arithmetic.

### 1.6 Revenue recognition

**A sale is recognised on delivery, not on order.** This is the single most important rule in the system and the reason the client's current numbers are wrong. Enforce it in one place: the shipment-delivered handler. An order that is placed, confirmed, booked and in transit contributes zero revenue.

### 1.7 Idempotency

Every sync writes through an upsert keyed on the external id. Every webhook checks `webhook_events(shopify_event_id)` before acting. Every worker run records to `sync_runs`. Re-running any sync twice must produce identical state. Write a test that does exactly that.

### 1.8 Multi-store and multi-account from day one

No table gets a Shopify id without a `store_id` beside it. No shipment without a `postex_account_id`. Unique constraints are always composite: `(store_id, shopify_order_id)`, not `shopify_order_id`. The two brands share a catalogue namespace only where SKUs genuinely match; otherwise they stay distinct.

### 1.9 Customer PII

Store only name, phone, address (the proposal's commitment). Phone is normalised to `+92…` in a dedicated column used for the confirmation desk's history lookup. The accountant role never sees phone numbers; enforce that in the API serialiser, not in the UI.

### 1.10 Consequences for the steps below

These follow from 1.1–1.9 and the batch and step order in sections 2 and 3.

- **One transition path.** Every shipment status change goes through the Step 7 state machine,
  which then calls the stock rules (Step 8) and posting rules (Step 10). Sync, backfill and replay
  all use that path. Nothing else recognises revenue (1.6).
- **Ledgers are filled by replay, not retrofitted.** `shipment_events` is append-only and keyed,
  and every stock move and journal entry carries its source (`ref_type/ref_id`,
  `source_type/source_id`). So when Step 8 or Step 10 lands, its ledger is built by replaying all
  history through the same path, then kept current by it. Nothing is back-edited.
- **Release 1 figures before the journal exists.** Until Step 10, "delivered revenue" on the
  dashboard is labelled *Delivered COD* and read from delivered shipments. It switches to the
  journal when Step 10 lands, and the two must agree for the same period.
- **Reservation is not a location.** It is not in the 1.4 list, and a reserved unit has not
  moved. `available = warehouse quant − open reservations`, where open reservations are the lines
  of orders that are not cancelled and have no shipment yet. A view, never a move.
- **Order `state` is written by one function only.** Step 7's recompute is the only writer of
  `orders.state` (1.3); every change is logged in `order_state_log`. A test fails if any other
  code writes the column.
- **Missing inputs do not block anything.** A delivery whose variant has no cost effective at the
  order date opens a `cost_missing` reconciliation item and its COGS posts once the cost exists.
  Warehouse quants may go negative until opening stock is loaded as dated opening moves;
  negatives are flagged, never clamped.
- **Raw payloads are kept, and they contain PII.** Webhook payloads in `webhook_events.payload`;
  the latest Shopify order in `orders.raw`; the latest PostEx parcel in `shipments.raw`, each
  history step in `shipment_events.raw`. PostEx has no sandbox, so these are the only replay
  source. `raw` and `payload` columns are never serialised to any role, and GDPR redaction
  (Step 4) scrubs them as well as the typed columns.
- **Corrections are reversals.** Stock moves and journal lines are never updated or deleted
  (enforced by trigger). A correction is a new reversing row with a reason and an actor.
- **Unknown is a state, not an error.** An unrecognised status code, an unmatched shipment, a COD
  mismatch: each opens a `reconciliation_items` row. Sync never crashes on data it does not
  understand.
- **No invented numbers.** A tile with no data shows "—", as the overview does today.

---

## 2. Schema, in build order

Migrations are numbered SQL files run by a small runner (`backend/src/db/migrate.ts`) against a `schema_migrations` table. No ORM. postgres.js with hand-written SQL and typed row interfaces.

### Batch A — foundations (step 1)

```
schema_migrations
stores                 id, key(nur|organics), label, shop_domain, currency
postex_accounts        id, key, label, store_id (nullable default link)
users                  id, email, name, role, password_hash, is_active
audit_log              id, actor_id, action, entity, entity_id, before, after, at
app_settings           key, value jsonb
sync_runs              id, job, account_ref, started_at, finished_at, status, stats jsonb, error
integration_cursors    job, account_ref, cursor, updated_at
```

`stores` and `postex_accounts` are seeded from config on boot so the existing env-driven setup keeps working.

### Batch B — catalogue (step 2)

```
products               id, store_id, shopify_product_id, title, brand, status
variants               id, product_id, shopify_variant_id, sku, title, barcode
                       unique (store_id, shopify_variant_id)
                       unique (store_id, sku) where sku is not null
product_costs          id, variant_id, unit_cost_paisa, effective_from, source, note
```

`product_costs` is **effective-dated**, never overwritten. COGS on a delivered order uses the cost effective at the order date, so profit history stays correct when prices change (proposal 6.1 step 4).

Juggun's Organics has no SKUs yet. Allow `sku IS NULL` and surface an "unmapped variants" screen; do not block ingest on it.

### Batch C — orders and customers (step 3)

```
customers              id, store_id, shopify_customer_id, name, phone_e164, email
addresses              id, customer_id, line1, line2, city, province, postal, country
orders                 id, store_id, shopify_order_id, order_number, placed_at,
                       customer_id, shipping_address_id, financial_status, fulfillment_status,
                       currency, subtotal, discount, shipping, tax, total_paisa,
                       channel(online|consignment|pr), cancelled_at, cancel_reason,
                       tags text[], discount_codes text[], raw jsonb
order_lines            id, order_id, variant_id (nullable), sku, title, qty, unit_price, discount, total
webhook_events         id, store_id, topic, shopify_event_id unique, received_at, processed_at, payload
```

`raw jsonb` keeps the untouched Shopify payload. It costs little and saves the project when a field turns out to matter later.

### Batch D — logistics (step 4)

```
shipments              id, postex_account_id, tracking_number (unique per account),
                       order_ref_number, order_id (nullable FK), match_confidence, match_method,
                       status_code, status_message, booked_at, delivered_at, status_updated_at,
                       cod_amount_paisa, city, customer_phone,
                       attempts_count, last_failure_reason, raw jsonb
shipment_events        id, shipment_id, code, message, occurred_at, raw
                       unique (shipment_id, code, occurred_at)
shipment_charges       id, shipment_id, kind(forward|forward_tax|reversal|reversal_tax),
                       amount_paisa, booked_at
cod_payouts            id, postex_account_id, cpr_number, paid_at, amount_paisa, raw
payout_lines           id, cod_payout_id, shipment_id, amount_paisa
reconciliation_items   id, kind, severity, shipment_id, order_id, detail jsonb,
                       status(open|resolved|ignored), resolved_by, resolved_at, note
```

`shipment_events` is append-only and uniquely keyed, so re-polling a parcel is free.

Verified PostEx field names to map (proven against live data): `invoicePayment`, `transactionFee`, `transactionTax`, `reversalFee`, `reversalTax`, `orderDeliveryDate`, `statusUpdatedAt`, `transactionStatusHistory[].{code,message,updatedAt}`, `cpr1`, `cpr1Date`. List and bulk endpoints wrap rows in `trackingResponse`.

Status codes that drive behaviour: `0005` delivered, `0013` attempt made (reason RFD/CNA/ICA/OPN), `0008` under review, `0040` return initiated, `0006` returned at merchant warehouse, `0002` cancelled by merchant.

### Batch E — inventory (step 5)

```
locations              id, kind, label, partner_id (nullable), is_active
stock_moves            id, variant_id, qty, from_location_id, to_location_id,
                       reason, ref_type, ref_id, actor_id, occurred_at, note
stock_quants           variant_id, location_id, qty   (materialised, rebuildable)
stock_adjustments      id, location_id, reason, note, actor_id, at
retail_partners        id, name, contact, phone, city, terms, location_id
consignment_transfers  id, partner_id, sent_at, status, note
partner_sales_imports  id, partner_id, period_start, period_end, file_name,
                       status, rows_ok, rows_failed, imported_by, at
```

### Batch F — purchase (step 6)

```
vendors, purchase_requests, quotations, quotation_lines,
purchase_orders, po_lines, goods_receipts, gr_lines,
vendor_bills, bill_lines, vendor_payments
```

Three-way match before payment: PO to receipt to bill. Goods receipt writes `product_costs` and a `supplier → warehouse` stock move.

### Batch G — accounting (step 7)

```
accounts               id, code, name, type(asset|liability|equity|income|expense), parent_id
journal_entries        id, entry_date, memo, source_type, source_id, posted_at, posted_by, reversed_by
journal_lines          id, entry_id, account_id, debit_paisa, credit_paisa,
                       partner_type, partner_id, store_id
                       constraint: per entry, SUM(debit) = SUM(credit)
tax_rates              id, name, percent, account_id
fiscal_periods         id, year, month, status(open|closed), closed_at, closed_by
invoices / invoice_lines / payments
bank_statements / bank_lines
```

Month closes on the 5th (proposal 6.5 step 6). Once closed, corrections post as dated adjustments in the next open period. Never silent edits — the audit log and the reversal chain are the feature.

### Batch H — confirmation and PR (step 8)

```
confirmations          id, order_id, state(pending|confirmed|no_answer|changed|cancelled|unreachable),
                       agent_id, attempts, next_attempt_at, outcome_reason, confirmed_at
confirmation_attempts  id, confirmation_id, agent_id, channel(whatsapp|call), at, outcome, note
influencers            id, handle, name, city, followers, niche, notes
influencer_codes       id, influencer_id, store_id, discount_code
pr_sends               id, influencer_id, created_by, status, shipment_id, order_id, cost_paisa, at
pr_send_lines          id, pr_send_id, variant_id, qty, unit_cost_paisa
influencer_posts       id, influencer_id, pr_send_id, url, kind(reel|story|post), posted_at, note
```

### 2.1 Review notes on the schema

Checked against section 1 before any SQL is written. Each item is either applied when its batch
is built (**applied**) or needs a decision (**decide**).

| # | Where | Issue | Resolution |
| --- | --- | --- | --- |
| 1 | Batch H | Order Confirmation Desk goes live at the end of week 2 (proposal §13), but `confirmations` is step 8. | **Applied:** Batch H is split. `confirmations` and `confirmation_attempts` land with Step 11, which moves into week 2 (see 3.1); the PR tables land with Step 13 in week 3. |
| 2 | Batch B | `variants` has `unique (store_id, …)` but no `store_id` column; it only reaches the store via `product_id`. | **Applied:** add `store_id` to `variants` (1.8: no Shopify id without `store_id` beside it). |
| 3 | Batch C | No unique keys on `orders`, `customers`, `products`. 1.7 upserts need them. | **Applied:** `unique (store_id, shopify_order_id)`, `unique (store_id, order_number)`, `unique (store_id, shopify_customer_id) where not null`, `unique (store_id, shopify_product_id)`. `shopify_order_id` is nullable for `consignment` orders, which have none. |
| 4 | Batch C | `webhook_events.shopify_event_id unique` on its own; 1.8 says composite. | **Applied:** `unique (store_id, shopify_event_id)`. |
| 5 | Batch C | Money columns `subtotal, discount, shipping, tax` and `order_lines.unit_price, discount, total` have no `_paisa` suffix. | **Applied:** every money column ends in `_paisa` (1.1), so a PKR value can never be mistaken for paisa in SQL. |
| 6 | Batch C | 1.3 says the order row carries a derived `state`; `orders` has no such column. | **Applied:** `orders.state` column written only by the Step 7 recompute, every change logged in `order_state_log` (1.10). |
| 7 | Batch C | COD orders are often guest checkouts with no Shopify customer. | **Applied:** a `customers` row is created from the shipping address when there is no `shopify_customer_id`; `index (phone_e164)` serves the cross-store history lookup. |
| 8 | Batch C | `customers.email` goes beyond 1.9 (name, phone, address only). | **Decide:** drop it, or amend 1.9. Default in the steps: not stored. |
| 9 | Batch D | `shipments.customer_phone` is a second copy of PII. | **Applied:** kept for matching unmatched shipments, but covered by the same accountant serialiser rule as `customers`. |
| 10 | Batch D | No unique keys on `shipment_charges`, `cod_payouts`, `payout_lines`. | **Applied:** `unique (shipment_id, kind)` (upserted: PostEx corrects fees late), `unique (postex_account_id, cpr_number)`, `unique (cod_payout_id, shipment_id)`. |
| 11 | Batch D | PostEx's payment status gives the CPR and date per shipment, not a net amount. | **Applied:** `payout_lines.amount_paisa` = COD − charges; `cod_payouts.amount_paisa` = sum of lines, checked against the PostEx settlement figures in Step 10. |
| 12 | Batch D | No status code for "picked up". | **Applied:** stock moves `warehouse → in_transit` when a shipment first appears in PostEx, matching the proposal's "dispatched = with PostEx". `0002` cancelled by merchant moves it back. |
| 13 | Batch D | No `returns` table; the returns register needs a warehouse check-in with condition and person. | **Applied:** no new table. The register is a view over `0040`/`0006` events plus the check-in stock move (`returning → warehouse` or `→ damaged`, with `actor_id`). |
| 14 | Batch D | `reconciliation_items` links only a shipment or an order; `cost_missing`, `negative_stock`, `variant_unmapped` concern a variant. | **Applied:** the variant id goes in `detail`; `kind` + `detail` are indexed. |
| 15 | Batch E | `locations.partner_id` and `retail_partners.location_id` point at each other. | **Applied:** keep `locations.partner_id` only. A two-way FK needs deferred constraints and can disagree. |
| 16 | Batch E | `stock_moves` has no idempotency key. 1.7 requires reruns to be identical. | **Applied:** `unique (ref_type, ref_id, variant_id, from_location_id, to_location_id)`; `qty > 0`; `from ≠ to`; no UPDATE/DELETE. |
| 17 | Batch G | `journal_entries` has no idempotency key either. | **Applied:** `unique (source_type, source_id) where reversed_by is null`; a reversal is its own entry with `source_type = 'reversal'`. |
| 18 | Batch A | No place for two-step login secrets (proposal §8). | **Applied:** `users.totp_secret` (encrypted), `user_recovery_codes`, added with Step 15. |
| 19 | Batch A | `postex_accounts.store_id` nullable. Shipments need a store for matching and reporting. | **Applied:** nullable in the table, but matching refuses to run for an account with no store, and says so in `/integrations/status`. |


### 2.2 Code conventions

- Migration files: `backend/migrations/NNNN_name.sql`, forward only. The runner takes a Postgres
  advisory lock so the web service and the worker can both start without racing.
- Modules live in `backend/src/modules/<name>/` with `repo.ts` (SQL + typed rows), `service.ts`
  (rules), `routes.ts` (HTTP, zod-validated). Integrations stay in `src/integrations/`.
  `src/lib/money.ts` (1.1) and `src/lib/time.ts` (1.2) are the only places amounts and PostEx
  timestamps are parsed.
- Tests: `node:test` (run through `tsx`). Integration tests run against a Neon branch
  (`DATABASE_URL_TEST`), never main. PostEx and Shopify tests use **recorded real responses** in
  `test/fixtures/`, with customer names, phones and addresses masked before they are committed.
- Frontend: React Router, TanStack Query, Recharts. One query hook per endpoint in
  `src/lib/queries/`.
- Every step ends with `npm run typecheck` and `npm test` (backend), and `npm run build` and
  `npm run lint` (frontend) green.

---

## 3. Build steps

Each step: what to build, what "done" means, how to prove it.

### Step 1 — Migration runner and foundations
Build the runner, Batch A tables, seed stores and PostEx accounts from config, extend `/health/db`.
**Done when:** `npm run migrate` is idempotent, `migrate:status` lists applied migrations, seeding twice changes nothing.

### Step 2 — Shopify catalogue import
Paginated GraphQL over products and variants for both stores, upsert into Batch B. Report unmapped SKUs.
**Done when:** both catalogues import, a second run changes zero rows, and the unmapped-SKU count for Juggun's Organics is reported rather than fatal.

### Step 3 — Shopify order backfill
`orders` query with an `updated_at` cursor, 60-day window (the API default), full line items, tags and discount codes. Store `raw`. Throttle via the existing backoff.
**Done when:** both stores backfill, counts match the Shopify admin for the same window, a second run is a no-op, cursor recorded in `integration_cursors`.

### Step 4 — Shopify webhooks + 15-minute catch-up
Register `orders/create`, `orders/updated`, `orders/cancelled`, `fulfillments/create|update`, `refunds/create`, plus the three mandatory GDPR topics. HMAC verification on the raw body (mount the raw parser **before** `express.json()`, on that route only). Dedupe on `X-Shopify-Event-Id`. A scheduled catch-up closes any gap.
**Done when:** a test order lands within seconds, replaying a webhook twice is a no-op, and a deliberately dropped webhook is recovered by the catch-up within 15 minutes.

Local dev needs a public URL for webhooks — use a tunnel. On Render the worker URL is public and stable.

### Step 5 — PostEx sync worker
Loop over both accounts: list orders by date window, then refresh detail for any parcel not in a terminal state. Respect the 1 req/s throttle already in the client. Cadence: every 15 minutes normally, every 5 for parcels out for delivery, daily sweep for anything stale. Write `shipments`, `shipment_events`, `shipment_charges`.
**Done when:** all ~1,073 historical parcels load with full event history and charges, and a re-run adds zero rows.

### Step 6 — Matching engine
Link shipment to order. Primary: `order_ref_number` equals the Shopify order name, scoped by account to store. Fallbacks in order: exact COD amount + city + date window; phone + date window. Anything else becomes a `reconciliation_items` row of kind `unmatched_shipment`.
**Done when:** match rate on historical data is at or above the 95.4% measured in the spike, every unmatched parcel has a queue row, no parcel is silently dropped.

### Step 7 — Order state machine
Derive order state from the three streams: `placed → confirmed → ready_to_book → booked → in_transit → delivered | failed → returning → returned_received`, plus `cancelled` and `pr`. Transitions are pure functions of (order, shipment, events), recomputed on every change, never hand-written. Log every transition.
**Done when:** replaying all historical events produces a state distribution matching the PostEx status counts, with unit tests over recorded fixtures.

### Step 8 — Stock ledger wired to the state machine

| Event | Move |
|---|---|
| Booked / dispatched | `warehouse → in_transit` |
| Delivered (0005) | `in_transit → customer` |
| Return initiated (0040) | `in_transit → returning` |
| Returned at warehouse (0006) | `returning → warehouse`, or `→ damaged` on check-in |
| PR send | `warehouse → marketing` |
| Consignment transfer | `warehouse → partner` |
| Partner sale | `partner → customer` |
| Count / correction | `adjustment ↔ warehouse` |

`0006` is PostEx saying the parcel is back, which is not the same as your team physically checking it in. Keep both: PostEx-returned and warehouse-received. The gap between them is exactly the alert the proposal promises.
**Done when:** `stock_quants` equals a full recompute from `stock_moves`, and the returns-not-checked-in alert fires on real data.

### Step 9 — Reconciliation queue
The five rules from proposal 6.6 step 6: unmatched parcel, COD differs from order total, possible duplicate booking, stuck in transit beyond N days, unknown PostEx status code. Each item gets resolve/ignore plus a note.
**Done when:** the queue is populated from historical data, every item type can be resolved, and each resolution is audited.

### Step 10 — Accounting engine

| Event | Debit | Credit |
|---|---|---|
| Delivered sale | COD Receivable (PostEx) | Sales Revenue, Tax Payable |
| COGS on delivery | Cost of Goods Sold | Inventory |
| PostEx forward charge + tax | Delivery Expense, Input Tax | COD Receivable |
| PostEx return charge + tax | Return Expense, Input Tax | COD Receivable / Payable |
| COD payout received | Bank | COD Receivable |
| Refused / returned parcel | reverse revenue and COGS, keep the charges | |
| PR send | Marketing Expense | Inventory |
| Vendor bill | Inventory / Expense, Input Tax | Accounts Payable |
| Vendor payment | Accounts Payable | Bank |
| Consignment sale | Partner Receivable | Sales Revenue, Tax Payable |

**Done when:** the trial balance balances on a full historical replay, and delivered revenue for a sample month reconciles to PostEx settlement figures within rounding.

### Step 11 — Confirmation Desk
Queue, customer history by phone (delivered vs refused count, city return rate), WhatsApp click-to-chat deep link with a templated message, call link, outcome capture, follow-up scheduling, unreachable escalation, agent performance. Optionally write a `confirmed` tag back to Shopify — the one write we allow, and only if the client asks.
**Done when:** an agent can work a real queue end to end, and both the "confirmed but not booked within 24h" and "cancelled but booked" alerts fire.

### Step 12 — Inventory, Purchase, Sales, Consignment UI
Screens over the batches already built. Partner sheet import with a fixed CSV template, dry-run preview, then commit. Reorder suggestions computed from **delivered** velocity, not placed orders.
**Done when:** a partner sheet imports, creates an invoice and moves stock, all reversible.

### Step 13 — Influencer PR
Manual PR sends, plus auto-detection of PR sends made outside the platform: Shopify orders tagged `PR` or fully discounted, and PostEx parcels with zero COD. The spike found 54 such parcels costing PKR 10,930.
**Done when:** those 54 parcels are classified as PR, excluded from sales and the return rate, and expensed to marketing.

### Step 14 — Reports and dashboards
Delivered revenue, net profit, return rate, delivery success rate, cash waiting with PostEx and its ageing, profit per parcel. Breakdowns by brand, store, product, city, month, partner, agent, influencer. P&L, GL, Trial Balance, Partner Ledger.
**Done when:** dashboard numbers tie to the ledger, and every figure clicks through to its underlying rows.

### Step 15 — Roles and real accounts
Replace the static login: argon2 hashes, the five roles (Owner, Manager, Operations, Confirmation agent, Accountant), field-level PII suppression for the accountant, TOTP 2FA for owner and manager.
**Done when:** each role sees only its own surface, verified by API tests, not UI checks.

### Step 16 — History import beyond 60 days
CSV import of each store's full order export, mapped to the same tables with `source = 'csv_import'` so it never collides with API rows. Request extended order access in parallel.
**Done when:** imported history reconciles against PostEx parcels from before the API window.

### Step 17 — Deploy
Render web service + background worker + static site, Neon Singapore. Scale-to-zero for months 1–4, always-on from month 5, per proposal section 10. Secrets in Render env, never in the repo. Daily sync-health alert. Monthly full export.
**Done when:** a push deploys, the worker runs on schedule, and a deliberate failure produces an alert.

### 3.1 Steps on the proposal timeline

The step numbers are dependency order, not calendar order. Release 1 at the end of week 2 promises
orders, returns and confirmations live (proposal §13, 30% milestone), which needs agents signed in
and the platform deployed. So three later-numbered steps are pulled forward, in part:

| Week | Steps | Notes |
| --- | --- | --- |
| 1 | 1, 2, 3, **17a**, 4, 5 | 17a = web service and worker on Render with secrets, done before Step 4 so webhooks have a stable public URL. The frontend is on Vercel instead of a Render static site: set `VITE_API_URL` there to the Render URL and add the Vercel origin to `CORS_ORIGIN`. Until the Render keys arrive, Step 4 webhooks need a tunnel to localhost. |
| 2 | 6, 7, 8, 9, **15a**, 11, payouts | 15a = real accounts and the five roles with PII suppression; TOTP can follow. "Payouts" is note S3 below. |
| **End of week 2** | **Release 1** | Parallel run against the manual sheet for two working days, then sign-off. |
| 3 | 10, 12, 13 | Step 10 replays all history into the journal (1.10). |
| 3–4 | 14, 16, 15b | 15b = TOTP for owner and manager. |
| 4 | 17b, UAT | 17b = alerts, monthly export, scale-to-zero settings. UAT, training and go-live (note S15). |

Weeks 1–2 carry eleven steps. If Release 1 is at risk, Step 8 can ship its schema and the
returns check-in in week 2 and replay stock in week 3 without changing anything else (1.10).

### 3.2 Review notes on the build steps

Checked against sections 1–2, the proposal and the current code. As in 2.1, **applied** means the
step is built that way; **decide** needs an answer before that step starts.

| # | Step | Issue | Resolution |
| --- | --- | --- | --- |
| S1 | 4 | Render background workers have no public URL; only web services do. | **Applied:** webhooks are served by the web service, which writes `webhook_events` and returns 200; the worker processes them. |
| S2 | 4 | The three GDPR topics are mandatory compliance webhooks set in the app's configuration on the Dev Dashboard, not created through the API like the others. `customers/redact` also means actually redacting, and `raw`/`payload` columns hold the same PII. | **Applied:** configured in the app, handled by the web service; redaction scrubs typed columns **and** `raw`/`payload` (1.10), logged in `audit_log`. |
| S3 | 5 | Step 5 writes `shipments`, `shipment_events`, `shipment_charges` but no step fills `cod_payouts`/`payout_lines`. Without them there is no "cash waiting with PostEx" (Step 14) and no payout posting (Step 10). | **Applied:** a daily payment-status job (delivered shipments without a payout line, oldest first; `cpr1`/`cpr1Date`) lands in week 2 alongside Step 5. |
| S4 | 5 | 15-minute polling with 5-minute out-for-delivery refreshes keeps Neon awake all day, above the ~8 active hours a day the months 1–4 hosting price assumes (proposal §10). | **Decide:** keep this cadence from 08:00–23:00 Karachi and go hourly overnight (default), or accept higher months 1–4 compute. Measured in week 2 either way. |
| S5 | 5 | "~1,073 historical parcels" is the NUR account only. | **Applied:** done also requires the Juggun's Organics account's full history, and a re-run *changes* zero rows as well as adding none (charges are upserted). |
| S6 | 7 | "Log every transition" needs a table; Batch C has none. | **Applied:** `orders.state` + `order_state_log (order_id, from_state, to_state, cause, at)` in Batch C (2.1 note 6). |
| S7 | 7 | `placed → confirmed` depends on `confirmations` (Step 11). | **Applied:** until Step 11, confirmation comes from the Shopify tags imported in Step 3; Step 11 turns those into historical `confirmations` rows. |
| S8 | 8 | The `0006` row reads as a stock move, but the paragraph under it (and 2.1 note 13) says the move happens at warehouse check-in. | **Applied:** `0006` records PostEx-returned and moves nothing; check-in moves `returning → warehouse` or `→ damaged`. |
| S9 | 8 | `0002` cancelled by merchant after booking has no row; the unit would stay `in_transit`. | **Applied:** `0002` moves `in_transit → warehouse`. |
| S10 | 8, 13 | "PR send: `warehouse → marketing`" at send time conflicts with 1.4 (`marketing` is terminal) and proposal §6.8 step 3: PR parcels are refused and returned like any other. A returned PR unit would have to leave a terminal sink. | **Decide:** recommended — PR parcels follow the normal path (`warehouse → in_transit`), and only delivery moves `in_transit → marketing`; a refused PR parcel comes back through `returning`. |
| S11 | 10 | "Refused / returned parcel: reverse revenue and COGS" contradicts 1.6. A refused COD parcel was never delivered, so no revenue or COGS was ever posted; there is nothing to reverse. | **Applied:** refused/returned posts only the return charge + tax. Reversal applies only to a return *after* delivery, if the client has that case (a Shopify refund on a delivered order, `refunds/create`). |
| S12 | 10 | Missing postings: consignment COGS (`partner → customer`), partner payment (Bank / Partner Receivable), damaged-return write-off, and PR parcels' PostEx charges (proposal §6.8 step 4 books them as marketing, not delivery expense). | **Applied:** added as rows in the posting rules, each with a test. |
| S13 | 10 | Sales tax: is the COD price tax-inclusive, and is the 16% on PostEx charges claimable as input tax? That depends on the client's registration. | **Decide:** with the client's accountant before Step 10. Default until then: Shopify tax lines as recorded, PostEx tax expensed, not claimed. |
| S14 | 10 | "Reconciles to PostEx settlement figures within rounding": revenue excludes tax and charges, so it will not equal settlements; and with integer paisa there is no rounding. | **Applied:** the check is COD Receivable movements vs `cod_payouts` + outstanding delivered COD, exact to the paisa. |
| S15 | — | Proposal items with no step: expense entry (ads, salaries, rent, packaging, §6.5 P&L), bank statement import and matching (§6.5 step 5), month close on the 5th (§6.5 step 6, Batch G `fiscal_periods`), opening stock and opening balances (§11 items 11, 15), payout-overdue > 14 days alert (§6.6), optional Shopify stock write-back (§6.2 step 6), UAT and training (§11, §15 final 30%). | **Applied:** expenses, bank import, close and opening balances in Step 10/14; opening stock in Step 8; payout alert with S3; stock write-back in Step 12 behind a flag, off by default; UAT in week 4 (3.1). |
| S16 | 13 | Proposal §6.8 describes the 54 zero-COD parcels as "PR packages, gifts or replacements". Auto-classifying all 54 as PR would book replacements as marketing. | **Applied:** detection suggests, a person confirms. Done when all 54 are classified (PR, replacement or gift), and the PR ones are excluded and expensed as written. |
| S17 | 1 | There is no `/health/db` today; `GET /ready` already checks the database. | **Applied:** `/ready` reports applied vs pending migrations; no new route. |
| S18 | 15 | The previous draft used `node:crypto` scrypt to avoid a native build. | **Applied:** argon2 via `@node-rs/argon2`, which ships prebuilt binaries and needs no build toolchain on Render. |
| S19 | 16 | `orders` has no `source` column, and Shopify's order export includes the order id, so CSV and API rows *can* collide for overlapping dates. | **Applied:** add `orders.source (api|csv_import)`; upsert on `(store_id, shopify_order_id)` with the API row winning, so overlap merges instead of duplicating. |
| S20 | 17 | "A deliberate failure produces an alert" — no alert channel is defined. The proposal excludes WhatsApp automation and says nothing about email. | **Decide:** email to the owner (recommended; one transactional email provider), or the in-dashboard alert list only. |
| S21 | 4 | `products/update` is not in the topic list, so catalogue changes appear only when Step 2 is re-run. | **Applied:** add `products/update`, and re-run Step 2 hourly as its catch-up. |

---

## 4. Client inputs this plan waits on

From proposal §11. None of them block ingest (1.10); each leaves a flagged gap until it arrives.

| Input | Needed by |
| --- | --- |
| Product cost prices with dates | Step 10 (COGS and profit stay pending until then) |
| Full order CSV per store; extended order access request | Step 16 |
| PostEx portal access or last two statements | Step 10 settlement check |
| Earlier PostEx account token, if any | Step 5 |
| Juggun's Organics SKUs | Step 2 (reported as unmapped until then) |
| Team members, emails, roles | Step 15a, Release 1 |
| Business WhatsApp number(s) and message wording | Step 11 |
| Opening stock count | Step 8 (quants flagged negative until then) |
| Retail partner list with stock held | Step 12 |
| Vendor list and open POs | Step 12 |
| Influencer list and discount codes | Step 13 |
| Opening balances and expense categories | Step 10, Step 14 |
| Sales tax treatment (note S13) | Step 10 |

---

## 5. Risks

- **R1. PostEx has no test environment.** Read-only client, recorded fixtures,
  `POSTEX_ALLOW_WRITES` refused outside production. Booking stays out of scope.
- **R2. PostEx field and status drift.** Labels already differ between endpoints. We key on
  history codes, keep raw payloads, and send unknown codes to reconciliation.
- **R3. Neon compute vs polling cadence.** See note S4. Active hours are measured in week 2 and
  reported before month 5.
- **R4. Shopify 60-day window.** Older orders depend on CSV exports or extended order access;
  Step 16 runs from either.
- **R5. Protected customer data.** Already on for both apps. New scopes (`write_orders` for the
  confirmed tag, `write_inventory` for stock write-back) only when their feature is switched on.
- **R6. Matching below 95%.** Fallbacks in Step 6 only link on a single unambiguous candidate;
  anything weaker goes to the queue.
- **R7. Ledgers filled late.** Stock (week 2–3) and journal (week 3) are built by replay, so the
  replay path runs on a Neon branch before main every time, and the *Delivered COD* vs journal
  check (note S14) is the gate.
- **R8. Weeks 1–2 are heavy.** Eleven steps before Release 1 (3.1). If week 3 slips, the cut
  order is: stock write-back, bank statement matching, influencer and agent breakdowns in
  Step 14 — each optional or reportable later without changing the ledgers.
