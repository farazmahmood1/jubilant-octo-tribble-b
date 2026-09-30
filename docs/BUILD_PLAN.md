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

These follow from 1.1–1.9 and the batch order in section 2.

- **One transition handler.** `src/modules/shipments/transitions.ts` is the only code that turns
  a shipment status change into effects. It is written with logistics (Batch D) and gains its
  stock effects when Batch E lands and its journal effects when Batch G lands. Sync, backfill and
  replay all go through it. Nothing else recognises revenue (1.6).
- **Ledgers are filled by replay, not retrofitted.** Because `shipment_events` is append-only and
  keyed, and every stock move and journal entry carries its source (`ref_type/ref_id`,
  `source_type/source_id`), each ledger can be built from history the day it lands. Stock
  (Batch E) and journal (Batch G) are populated by replaying every event through the handler,
  then kept current by the same handler. Nothing is back-edited.
- **Release 1 figures before the journal exists.** Until Batch G, "delivered revenue" on the
  dashboard is labelled *Delivered COD* and read from delivered shipments. It switches to the
  journal when Batch G lands, and the two must agree to the paisa for the same period.
- **Reservation is not a location.** It is not in the 1.4 list, and a reserved unit has not
  moved. `available = warehouse quant − open reservations`, where open reservations are the lines
  of orders that are not cancelled and have no shipment yet. A view, never a move.
- **The order `state` is a view** (`order_states`), derived from the latest confirmation, the
  shipment and the postings. It is never a column anyone can write (1.3).
- **Missing inputs do not block anything.** A delivery whose variant has no cost effective at the
  order date opens a `cost_missing` reconciliation item and its COGS posts once the cost exists.
  Warehouse quants may go negative until opening stock is loaded as dated opening moves;
  negatives are flagged, never clamped.
- **Raw payloads are kept.** Webhook payloads in `webhook_events.payload`; the latest Shopify
  order in `orders.raw`; the latest PostEx parcel in `shipments.raw`, and each history step in
  `shipment_events.raw`. PostEx has no sandbox, so these are the only replay source.
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

Checked against section 1 before any SQL is written. Each item is either applied in the steps
below (**applied**) or needs a decision (**decide**).

| # | Where | Issue | Resolution |
| --- | --- | --- | --- |
| 1 | Batch H | Order Confirmation Desk goes live at the end of week 2 (proposal §13), but `confirmations` is step 8. | **Applied:** Batch H is split. `confirmations` and `confirmation_attempts` land right after Batch D (step CNF-1); the PR tables land in week 3. |
| 2 | Batch B | `variants` has `unique (store_id, …)` but no `store_id` column; it only reaches the store via `product_id`. | **Applied:** add `store_id` to `variants` (1.8: no Shopify id without `store_id` beside it). |
| 3 | Batch C | No unique keys on `orders`, `customers`, `products`. 1.7 upserts need them. | **Applied:** `unique (store_id, shopify_order_id)`, `unique (store_id, order_number)`, `unique (store_id, shopify_customer_id) where not null`, `unique (store_id, shopify_product_id)`. `shopify_order_id` is nullable for `consignment` orders, which have none. |
| 4 | Batch C | `webhook_events.shopify_event_id unique` on its own; 1.8 says composite. | **Applied:** `unique (store_id, shopify_event_id)`. |
| 5 | Batch C | Money columns `subtotal, discount, shipping, tax` and `order_lines.unit_price, discount, total` have no `_paisa` suffix. | **Applied:** every money column ends in `_paisa` (1.1), so a PKR value can never be mistaken for paisa in SQL. |
| 6 | Batch C | 1.3 says the order row carries a derived `state`; `orders` has no such column. | **Applied:** `order_states` view (1.10), so it cannot be written by hand. |
| 7 | Batch C | COD orders are often guest checkouts with no Shopify customer. | **Applied:** a `customers` row is created from the shipping address when there is no `shopify_customer_id`; `index (phone_e164)` serves the cross-store history lookup. |
| 8 | Batch C | `customers.email` goes beyond 1.9 (name, phone, address only). | **Decide:** drop it, or amend 1.9. Default in the steps: not stored. |
| 9 | Batch D | `shipments.customer_phone` is a second copy of PII. | **Applied:** kept for matching unmatched shipments, but covered by the same accountant serialiser rule as `customers`. |
| 10 | Batch D | No unique keys on `shipment_charges`, `cod_payouts`, `payout_lines`. | **Applied:** `unique (shipment_id, kind)` (upserted: PostEx corrects fees late), `unique (postex_account_id, cpr_number)`, `unique (cod_payout_id, shipment_id)`. |
| 11 | Batch D | PostEx's payment status gives the CPR and date per shipment, not a net amount. | **Applied:** `payout_lines.amount_paisa` = COD − charges; `cod_payouts.amount_paisa` = sum of lines, checked against the portal statements (ACC-8). |
| 12 | Batch D | No status code for "picked up". | **Applied:** stock moves `warehouse → in_transit` when a shipment first appears in PostEx, matching the proposal's "dispatched = with PostEx". `0002` cancelled by merchant moves it back. |
| 13 | Batch D | No `returns` table; the returns register needs a warehouse check-in with condition and person. | **Applied:** no new table. The register is a view over `0040`/`0006` events plus the check-in stock move (`returning → warehouse` or `→ damaged`, with `actor_id`). |
| 14 | Batch D | `reconciliation_items` links only a shipment or an order; `cost_missing`, `negative_stock`, `variant_unmapped` concern a variant. | **Applied:** the variant id goes in `detail`; `kind` + `detail` are indexed. |
| 15 | Batch E | `locations.partner_id` and `retail_partners.location_id` point at each other. | **Applied:** keep `locations.partner_id` only. A two-way FK needs deferred constraints and can disagree. |
| 16 | Batch E | `stock_moves` has no idempotency key. 1.7 requires reruns to be identical. | **Applied:** `unique (ref_type, ref_id, variant_id, from_location_id, to_location_id)`; `qty > 0`; `from ≠ to`; no UPDATE/DELETE. |
| 17 | Batch G | `journal_entries` has no idempotency key either. | **Applied:** `unique (source_type, source_id) where reversed_by is null`; a reversal is its own entry with `source_type = 'reversal'`. |
| 18 | Batch A | No place for two-step login secrets (proposal §8). | **Applied:** `users.totp_secret` (encrypted), `user_recovery_codes`, added with FND-4. |
| 19 | Batch A | `postex_accounts.store_id` nullable. Shipments need a store for matching and reporting. | **Applied:** nullable in the table, but matching refuses to run for an account with no store, and says so in `/integrations/status`. |

---

## 3. Build steps

Each phase maps to one or more schema batches. Step ids use phase codes so they cannot be
confused with batch letters.

### Conventions

- Migration files: `backend/migrations/NNNN_name.sql`, forward only, runner takes a Postgres
  advisory lock so web and worker can both start without racing.
- Modules live in `backend/src/modules/<name>/` with `repo.ts` (SQL + typed rows), `service.ts`
  (rules), `routes.ts` (HTTP, zod-validated). Integrations stay in `src/integrations/`.
- Tests: Vitest. Integration tests run against a Neon branch (`DATABASE_URL_TEST`), never main.
  PostEx and Shopify tests use **recorded real responses** in `test/fixtures/`.
- Frontend: React Router, TanStack Query, Recharts. One query hook per endpoint in
  `src/lib/queries/`.
- Every step ends with `npm run typecheck`, `npm test` (backend) and `npm run build`,
  `npm run lint` (frontend) green.

### Phase map

Follows proposal §13. Two releases, each signed off before the next phase starts.

| Phase | Batches | Weeks | Ends with |
| --- | --- | --- | --- |
| FND Foundation | A | 1 | Runner, users and roles, worker, deploy on Render |
| ORD Catalogue & orders | B, C | 1 | Both stores syncing by webhook and poll |
| SHP Shipments & returns | D | 1–2 | Both PostEx accounts syncing, matched, returns register, payouts, reconciliation |
| CNF Confirmation desk | H (confirmation part) | 2 | Agents confirming orders in the platform |
| **R1 Release 1** | | end of week 2 | **Orders, returns and confirmations live** (30% milestone) |
| INV Inventory & consignment | E | 3 | Stock ledger replayed from history, partners, counts |
| PUR Purchase | F | 3 | Request → quote → PO → receipt → bill → payment |
| PR Influencer PR | H (PR part) | 3 | PR sends, detection, results |
| ACC Accounting & profit | G | 3–4 | Journal replayed from history, reports, close, profit dashboards |
| UAT UAT & go-live | | 4 | **Full go-live** (final 30%) |

---

### Phase FND — Foundation (week 1, Batch A)

**FND-1. Migration runner and test harness**
- `src/db/migrate.ts`, `npm run migrate`, `0001_foundations.sql` with Batch A.
- Vitest; `npm test` for unit tests, `npm run test:db` against `DATABASE_URL_TEST`.
- `src/lib/money.ts` (1.1: parse `"1250.00"` → `125000n`, format for display) and
  `src/lib/time.ts` (1.2: Karachi day/month boundaries, `parseKarachiLocal()` for PostEx strings).
  The only two places those conversions happen.
- **Done when:** runner applies Batch A on an empty Neon branch and is a no-op the second time;
  money/time tests pass, including a PostEx timestamp near midnight Karachi.

**FND-2. Seed from config on boot**
- On start, upsert `stores` and `postex_accounts` from `config.shopify.stores` and
  `config.postex.accounts` by `key`. Labels update; rows are never deleted.
- **Done when:** removing a store from `.env` leaves its row and data intact; adding one creates it.

**FND-3. Real users and roles**
- Replace the env single-user in `src/auth/session.ts` with `users`. Password hashing with
  `node:crypto` scrypt (no native build on Render). `/auth/login` and `/auth/me` keep their shapes.
- Roles: `owner`, `manager`, `operations`, `agent`, `accountant` (proposal §8). `requireRole(...)`
  and a `permissions.ts` map.
- Role-aware response serialisers drop PII (`phone_e164`, addresses, `shipments.customer_phone`)
  for `accountant` (1.9). Routes never hand-pick fields.
- `npm run user:create` for the first owner; env credentials only as a bootstrap when `users` is
  empty, refused in production.
- **Done when:** owner signs in from the DB; an accountant token gets 403 on agent routes and no
  PII on shared routes (API tests).

**FND-4. Two-step login for owner and manager**
- TOTP on `node:crypto`, `users.totp_secret` encrypted with a key from env, hashed recovery codes.
- **Done when:** owner and manager cannot get a token without a valid code.

**FND-5. Audit log helper**
- `audit(sql, actor, action, entity, before, after)` inside the same transaction as the change.
- **Done when:** the audit row rolls back with a failed transaction (test).

**FND-6. Worker and scheduler**
- `src/worker.ts` (`npm run worker`) for the Render background worker. Jobs are
  `{ name, everyMs, run }`, guarded by `pg_try_advisory_lock`, recorded in `sync_runs`, cursors
  in `integration_cursors`.
- **No DB-polling job queue** (pg-boss etc.): it keeps Neon awake and breaks the scale-to-zero
  budget in proposal §10. See risk R3.
- **Done when:** a no-op job runs on schedule, a second worker skips it, `sync_runs` records it.

**FND-7. Deploy to Render (Singapore)**
- `render.yaml`: web service (`build → migrate → start`), background worker, static site with
  `VITE_API_URL`. Neon project in Singapore with `main` and `dev` branches.
- Fix while here: frontend `IntegrationStatus` expects `ready`, backend returns `configured`.
- **Done when:** the deployed dashboard signs in over HTTPS with all four integrations green.

---

### Phase ORD — Catalogue & orders (week 1, Batches B and C)

**ORD-1. Catalogue schema and sync**
- `0002_catalogue.sql`: Batch B with review notes 2.
- Job `shopify.catalogue.poll` hourly per store; `products/update` webhook later reuses the mapper.
- Unmapped variants screen: variants with `sku IS NULL`, per store.
- **Done when:** both catalogues load; Juggun's Organics variants without SKUs are listed, not
  rejected.

**ORD-2. Order schema and mapper**
- `0003_orders.sql`: Batch C with review notes 3–8; `order_states` view.
- `src/integrations/shopify/queries.ts` (order fragment: lines, shipping address, discount codes,
  tags, cancel reason) and `src/modules/orders/mapper.ts`, pure, phone normalised to `+92…`.
- **Done when:** fixture tests cover a COD order, a guest checkout, a cancelled order, a fully
  discounted PR order and an order with a confirmation tag.

**ORD-3. Catch-up poll (15 minutes)**
- Job `shopify.orders.poll` per store: `updated_at >= cursor − 10 min`, paged, upsert, advance the
  cursor only after commit.
- **Done when:** first run loads the last 60 days for both stores; **the 1.7 test**: running the
  poll twice leaves every row identical (row hashes compared); counts match Shopify admin for a
  sample day.

**ORD-4. Webhooks**
- `POST /webhooks/shopify/:store` with `express.raw()` before `express.json()`. HMAC-SHA256 over
  the raw body with the store's client secret, constant-time compare. Insert into
  `webhook_events` on `(store_id, X-Shopify-Event-Id)`; on conflict answer 200 and stop. Process,
  set `processed_at`.
- Topics: `orders/create`, `orders/updated`, `orders/cancelled`, `products/update`,
  `app/uninstalled`. `npm run shopify:webhooks` registers them idempotently.
- **Done when:** a test order on each store appears within seconds; a tampered body gets 401; a
  replayed event id changes nothing; unprocessed events are retried by the poll.

**ORD-5. Orders API and pages**
- `GET /orders` (store, state, city, date, search by number/phone), `GET /orders/:id`.
- Frontend: React Router, TanStack Query, `/orders`, `/orders/:id`.
- **Done when:** search by order number or phone works on a phone-width screen.

---

### Phase SHP — Shipments & returns (weeks 1–2, Batch D)

**SHP-1. Logistics schema and PostEx mapper**
- `0004_logistics.sql`: Batch D with review notes 9–14.
- `src/integrations/postex/status-codes.ts`: every code seen in recorded history mapped to a
  behaviour; the six in Batch D drive transitions, the rest are informational. Unknown code →
  reconciliation item.
- `src/integrations/postex/mapper.ts`: parcel → `shipments`, `shipment_events`,
  `shipment_charges`, using the verified field names. Every timestamp through
  `parseKarachiLocal()`, every amount through `money.ts`, here and nowhere else.
- **Done when:** mapper fixture tests pass for delivered, refused-and-returned, cancelled and
  zero-COD parcels.

**SHP-2. PostEx sync**
- Job `postex.shipments.list` per account: rolling 45-day booked window to discover shipments.
- Job `postex.shipments.track`: `trackBulk` for non-terminal shipments; every 10 minutes for
  out-for-delivery/attempted, 30 minutes otherwise, daily for 7 days after a terminal code (late
  fee corrections). Respects the client's 1 req/s throttle.
- **Done when:** every NUR shipment since 14 May 2026 is loaded; running the sync twice changes
  nothing; totals reproduce proposal §3 for 14 May – 19 Sep (1,073 booked, 117 returned,
  PKR 27,787 return charges, PKR 209,009 delivery charges).

**SHP-3. The transition handler**
- `src/modules/shipments/transitions.ts`, one function per edge, run in the same transaction as
  the event insert. Effects arrive with their batch; the edges are fixed now:

  | Edge | Shipment | Stock (INV) | Journal (ACC) |
  | --- | --- | --- | --- |
  | first seen in PostEx | `booked_at` | `warehouse → in_transit` | — |
  | `0002` cancelled by merchant | terminal | `in_transit → warehouse` | — |
  | `0013` attempt made | `attempts_count++`, `last_failure_reason` | — | — |
  | `0008` under review | flag | — | — |
  | **`0005` delivered** | `delivered_at` | `in_transit → customer` (or `→ marketing` for PR) | sale + COGS + forward charge & tax (or marketing expense for PR) |
  | `0040` return initiated | | `in_transit → returning` | — |
  | `0006` returned at merchant | awaiting check-in | — | reversal charge & tax |
  | warehouse check-in (SHP-5) | | `returning → warehouse` or `→ damaged` | damaged: write-off |

- The `0005` edge is the only place revenue is recognised (1.6).
- **Done when:** a test per edge; a test that an order placed, confirmed, booked and in transit
  contributes zero revenue.

**SHP-4. Shipment ↔ order matching**
- Normalise `orderRefNumber` (`#63648`, `63648`, `NUR-63648`) → `(store_id, order_number)` via
  the account's store. `match_method = 'ref'`, `match_confidence = 1`.
- Fallback for manual bookings: same store, equal COD, equal city, booked within 3 days of the
  order, single candidate → `match_method = 'heuristic'`, a `match_suggested` item for a person.
  Anything else → `shipment_unmatched`.
- **Done when:** ≥ 95% of NUR shipments match by ref (proposal §9 measured 95.4%); every other one
  is in the queue; none silently dropped.

**SHP-5. Failed deliveries and returns register**
- Failed deliveries view: `0013` events with the reason code (RFD refused, CNA not available,
  ICA incomplete address, OPN wants to open) and attempt counts.
- Returns register view (review note 13) with reason, refusal date, return date, reversal charge,
  check-in state. Check-in action for `operations`, audited.
- **Done when:** all 117 historical returns appear with charge and dates; check-in records who and
  when, and (once INV lands) moves the stock.

**SHP-6. COD payouts**
- Job `postex.payments` daily: `paymentStatus` for delivered shipments without a payout line,
  oldest first; `cpr1`/`cpr1Date` → `cod_payouts` + `payout_lines` (review note 11).
- Ageing of delivered-unpaid: 0–7, 8–14, 15–30, 30+ Karachi days (proposal §6.5).
- **Done when:** the proposal §3 sample (delivered 27 June, paid 2 July) is correct; "cash with
  PostEx" has a real number.

**SHP-7. Reconciliation queue and alerts**
- Kinds: `shipment_unmatched`, `match_suggested`, `cod_mismatch`, `possible_duplicate`,
  `stuck_in_transit`, `under_review`, `unknown_status`, `return_not_checked_in`,
  `payout_overdue` (> 14 days), `sync_failing`. Later: `variant_unmapped`, `cost_missing`,
  `negative_stock`.
- Hourly job opens items and resolves them when the condition clears. Thresholds in
  `app_settings`.
- Queue page: link a shipment to an order, resolve, ignore with a note.
- **Done when:** each kind has a create-and-clear test.

**SHP-8. Shipments pages and first dashboard**
- `/shipments` (status, city, store, date, days in transit), timeline on `/orders/:id`.
- Overview tiles: *Delivered COD* (1.10), return rate, delivery success rate, cash with PostEx.
  Net profit stays "—". Returns-by-city and charges-by-month charts.
- **Done when:** tiles for 14 May – 19 Sep match proposal §3.

---

### Phase CNF — Confirmation desk (week 2, Batch H part 1)

**CNF-1. Confirmation schema and history**
- `0005_confirmations.sql`: `confirmations`, `confirmation_attempts` (review note 1).
- A `pending` confirmation is created for every new COD order. Existing Shopify confirmation tags
  become historical confirmations on first load (proposal §6.4).
- **Done when:** historical orders show the state their tags implied.

**CNF-2. Queue and customer history**
- Queue: pending and due `no_answer` (`next_attempt_at <= now`) from both stores, oldest first;
  after N attempts → `unreachable` for a manager.
- Each row: items, amount, city, delivered/refused counts for the same `phone_e164` across both
  stores, city return rate, repeat-refuser flag.
- **Done when:** a new Shopify order is in the queue within seconds of its webhook.

**CNF-3. Agent actions**
- `https://wa.me/<phone>?text=<template>` with the store's template from `app_settings`; `tel:`
  for calls; one click records an attempt and its outcome.
- Optional `confirmed` tag written back to Shopify (needs `write_orders`; off by default).
- **Done when:** an agent works the queue end to end on a phone.

**CNF-4. Release for dispatch**
- "Ready to book": confirmed, no shipment. Matching (SHP-4) moves it to dispatched.
- Alerts: confirmed and not booked within one Karachi business day; shipment booked for a
  cancelled order.
- **Done when:** both alerts fire in tests.

**CNF-5. Agent performance**
- Confirmation rate, median time to confirm, unreachable rate, confirmed-then-refused, by agent.
- **Done when:** the report shows per-agent figures for a date range.

**R1. Release 1 — orders, returns, confirmations**
- Staff accounts, short guides for agents and warehouse check-in.
- Two working days of parallel run against the manual sheet.
- **Done when:** client signs off; 30% milestone invoiced.

---

### Phase INV — Inventory & consignment (week 3, Batch E)

**INV-1. Inventory schema**
- `0006_inventory.sql`: Batch E with review notes 15–16. Seed one location per kind in 1.4
  (`warehouse`, `in_transit`, `returning`, `customer`, `marketing`, `damaged`, `supplier`,
  `adjustment`); `partner` locations come with partners.
- `moveStock()` in `src/ledgers/stock.ts` is the only writer of `stock_moves` and updates
  `stock_quants` in the same transaction. `npm run stock:rebuild` recomputes quants and diffs.
- **Done when:** a move cannot be updated, deleted or made without both locations; rebuild on a
  scripted scenario reports zero diff.

**INV-2. Switch on stock effects and replay history**
- Enable the stock column of SHP-3. `npm run ledger:replay -- --stock` runs every shipment event
  and check-in through the handler, in order.
- **Done when:** replay twice gives identical `stock_moves`; `returning` holds exactly the units
  of returns not yet checked in; each path in proposal §2's diagram has an end-to-end test.

**INV-3. Opening stock and counts**
- Opening count (proposal §11 item 11) as dated `adjustment → warehouse` moves. Negative quants
  before that raise `negative_stock`.
- Counts, damage and write-offs through `stock_adjustments` + moves, reason and actor required,
  audited.
- **Done when:** a count posts the difference as a move, never an overwrite.

**INV-4. Stock views**
- Quants per (variant, location); `available` (1.10); days of cover from delivered sales;
  low-stock thresholds in `app_settings`.
- **Done when:** the stock page and `stock:rebuild` agree for every (variant, location).

**INV-5. Retail partners and consignment**
- `retail_partners`, each with a `partner` location; `consignment_transfers` move
  `warehouse → partner`.
- Partner sales import: template download, preview with validation, commit → a `consignment`
  order with lines, `partner → customer` moves. Same file twice is rejected.
- **Done when:** a sample partner sheet imports and the partner's quants drop accordingly.

**INV-6. Optional stock write-back to Shopify**
- Per-store flag, **off** until the client confirms counts match (proposal §6.2 step 6). Needs
  `write_inventory`. Until then it is a dry-run diff.
- **Done when:** the diff is visible and nothing is written with the flag off.

---

### Phase PUR — Purchase (week 3, Batch F)

**PUR-1. Vendors, requests, quotations, POs**
- `0007_purchase.sql`: Batch F. Reorder suggestions from delivered-sales velocity, not placed
  orders (proposal §6.1 step 1).
- **Done when:** request → quote comparison → PO works for one vendor.

**PUR-2. Goods receipts**
- Partial receipts against a PO; each writes a `product_costs` row (effective from receipt date)
  and `supplier → warehouse` moves.
- **Done when:** a partial receipt leaves the PO open for the rest.

**PUR-3. Bills and payments**
- Three-way match (PO → receipt → bill) before payment; vendor balance.
- **Done when:** a bill that does not match its receipt cannot be paid without a manager override,
  which is audited.

**PUR-4. Cost import**
- The client's cost sheet (proposal §11 item 6) into `product_costs` with its dates,
  `source = 'import'`.
- **Done when:** cost at any past date returns the cost effective on that date.

---

### Phase PR — Influencer PR (week 3, Batch H part 2)

**PR-1. Influencers and PR sends**
- `0008_pr.sql`: `influencers`, `influencer_codes`, `pr_sends`, `pr_send_lines`,
  `influencer_posts`.
- A PR send's shipment follows the normal edges but ends in `marketing` (SHP-3), never in sales,
  returns or the return rate.
- **Done when:** a delivered PR send ends in `marketing` and leaves the return rate unchanged.

**PR-2. Detect PR sends made outside the platform**
- Orders tagged `PR` or 100% discounted (`channel = 'pr'`); shipments with `invoicePayment = 0`
  (54 found in proposal §6.8). Suggested for a person to confirm.
- **Done when:** the 54 zero-COD shipments appear as suggestions; confirming one re-runs its
  events through the handler.

**PR-3. Results**
- Discount code → influencer; delivered orders using it credited. Cost per influencer and
  campaign vs sales; posts recorded by the team.
- **Done when:** the report shows cost, posts and attributed delivered sales per influencer.

---

### Phase ACC — Accounting & profit (weeks 3–4, Batch G)

**ACC-1. Accounting schema and posting helper**
- `0009_accounting.sql`: Batch G with review note 17. A deferred constraint trigger rejects an
  unbalanced entry; no UPDATE/DELETE on lines.
- Chart of accounts seeded for both brands (brand as `journal_lines.store_id`, one chart).
- `postJournal()` in `src/ledgers/journal.ts` is the only writer.
- **Done when:** an unbalanced entry fails to commit; a duplicate source posts nothing.

**ACC-2. Posting rules and replay**
- Enable the journal column of SHP-3, plus payouts (PostEx receivable → bank), goods receipts,
  vendor bills and payments, consignment invoices and payments, PR sends, write-offs.
- COGS uses the `product_costs` row effective at the **order date** (Batch B note).
- `npm run ledger:replay -- --journal` posts all history.
- **Done when:** the trial balance balances after replay; replay twice posts nothing new; the
  PostEx receivable equals "cash with PostEx" from SHP-6; journal sales for 14 May – 19 Sep
  equal *Delivered COD* to the paisa, and the tile switches to the journal.

**ACC-3. Expenses, invoices and tax**
- Expense entry by category (ads, salaries, rent, packaging), audited.
- Invoices for delivered orders and consignment sales; tax via `tax_rates`. No FBR filing
  (exclusion).
- **Done when:** expenses appear in P&L; monthly tax totals export to CSV.

**ACC-4. Bank statements**
- CSV import into `bank_statements` / `bank_lines`; match to `cod_payouts` and partner/vendor
  payments; unmatched lines to reconciliation.
- **Done when:** one real statement month matches its CPR deposits.

**ACC-5. Reports and month-end close**
- GL, Trial Balance, Partner Ledger (customers, vendors, retail partners, PostEx), P&L by
  month/brand/store — queries over `journal_lines` only.
- `fiscal_periods`: close on the 5th (Karachi); posting into a closed period is rejected and goes
  in as an adjustment in the next open period.
- Opening balances from the accountant (proposal §11 item 15).
- **Done when:** closing September blocks a back-dated posting and the adjustment lands in October.

**ACC-6. Profit dashboards**
- Net profit, order funnel (placed → confirmed → dispatched → delivered/returned, count and
  value), profit per shipment, profit by product **after returns**, by city, cash-flow ageing,
  inventory value, low stock with days of cover.
- **Done when:** every figure drills down to the orders, shipments or journal entries behind it.

**ACC-7. History import**
- Shopify orders older than 60 days from the client's CSV export (proposal §11 item 2) or
  `read_all_orders` if approved — same mapper as ORD-2.
- An earlier PostEx account (proposal §11 item 5): new `postex_accounts` row, run SHP-2.
- **Done when:** history imports into a Neon branch first, totals are checked with the client,
  then it is replayed on main.

**ACC-8. Statement check and monthly export**
- PostEx portal statements (proposal §11 item 4) compared with `cod_payouts` totals.
- Job on the 1st: every table to CSV in a zip for the owner (proposal §8, §17).
- **Done when:** payouts agree with statements or each difference is a reconciliation item; the
  export restores into an empty database with matching row counts.

---

### Phase UAT — UAT and go-live (week 4)

- **UAT-1. Security pass:** role matrix test for every route, PII stripping, login rate limit,
  secrets only in Render env, CSP on the static site.
- **UAT-2. Performance:** list endpoints paged and indexed; overview under 1 s on a warm Neon.
- **UAT-3. Monitoring:** daily sync health, failed-job and unknown-status alerts (proposal §16).
- **UAT-4. UAT:** scripted scenarios per module with the client's team; fixes; training and short
  how-to guides per role.
- **UAT-5. Full go-live:** Neon always-on from month 5 as budgeted; final 30% milestone.

---

## 4. Client inputs this plan waits on

From proposal §11. None of them block ingest (1.10); each leaves a flagged gap until it arrives.

| Input | Needed by |
| --- | --- |
| Product cost prices with dates | PUR-4, ACC-2 (COGS and profit stay pending) |
| Full order CSV per store; `read_all_orders` request | ACC-7 |
| PostEx portal access or last two statements | ACC-8 |
| Earlier PostEx account token, if any | ACC-7 |
| Juggun's Organics SKUs | ORD-1 (listed as unmapped until then) |
| Team members, emails, roles | FND-3, R1 |
| Business WhatsApp number(s) and message wording | CNF-3 |
| Opening stock count | INV-3 (quants flagged negative until then) |
| Retail partner list with stock held | INV-5 |
| Vendor list and open POs | PUR-1 |
| Influencer list and discount codes | PR-1, PR-3 |
| Opening balances and expense categories | ACC-3, ACC-5 |

---

## 5. Risks

- **R1. PostEx has no test environment.** Read-only client, recorded fixtures,
  `POSTEX_ALLOW_WRITES` refused outside production. Booking stays out of scope.
- **R2. PostEx field and status drift.** Labels already differ between endpoints. We key on
  history codes, keep raw payloads, and send unknown codes to reconciliation.
- **R3. Neon scale-to-zero vs polling.** The months 1–4 budget assumes ~8 active DB hours a day;
  a 10-minute poll wakes Neon all day. Poll PostEx every 10–30 minutes 08:00–23:00 Karachi and
  hourly overnight; webhooks still wake it for new orders. Measure active hours in week 2.
- **R4. Shopify 60-day window.** Older orders depend on CSV exports or `read_all_orders`;
  ACC-7 runs from either.
- **R5. Protected customer data.** Already on for both apps. New scopes (`write_orders`,
  `write_inventory`) only when their feature is switched on.
- **R6. Matching below 95%.** Manual bookings go to suggested/unmatched, never auto-linked on weak
  evidence.
- **R7. Ledgers filled late.** Stock (week 3) and journal (weeks 3–4) are built by replay, so the
  replay path is exercised on every deploy to a Neon branch before main, and the *Delivered COD*
  vs journal check in ACC-2 is the gate.
- **R8. Four weeks for eight modules.** Release 1 scope is fixed (FND, ORD, SHP, CNF). If week 3
  slips, the cut order is INV-6 write-back, ACC-4 bank matching, PR-3 reports — each optional or
  reportable later without changing the ledgers.
