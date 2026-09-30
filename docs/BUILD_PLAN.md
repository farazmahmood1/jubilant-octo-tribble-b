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

## 1. Ground rules

These apply to every step. A PR that breaks one is not done, whatever else it does.

1. **Three axes, never one status column.** Every order carries separately: what happened to the
   **parcel** (PostEx), what happened to the **money** (COD, payout, charges), and where the
   **stock** is (ledger bucket). Proposal §2. Reports join the three; nothing collapses them.
2. **Raw first, derived second.** Every Shopify payload and every PostEx response is stored as
   received (`jsonb`) before it is interpreted. Derived tables can always be rebuilt from raw.
   PostEx has no sandbox and no history API beyond what it returns today, so raw rows are the
   only replay source.
3. **Append-only ledgers.** Stock movements and journal entries are never updated or deleted. A
   correction is a new, reversing row with a reason and a user. Proposal §6.2, §6.5.
4. **Idempotent sync.** Every write from Shopify or PostEx is an upsert keyed on the source's own
   id (`shopify_order_id`, `tracking_number`, `(tracking_number, code, updated_at)` for history).
   Running any job twice changes nothing the second time.
5. **Money in paisa.** All amounts are `bigint` minor units (PKR × 100). Parse Shopify decimal
   strings and PostEx numbers once, at the edge, with one helper. No floats past the adapter.
6. **Dates.** Store `timestamptz` (UTC). Report in `Asia/Karachi`. PostEx date filters are
   merchant-local `yyyy-mm-dd`; convert at the adapter.
7. **Store and brand on every row.** `store_key` (`nur` | `organics`) is part of every business
   table, and the PostEx account → store mapping is data, not code.
8. **PII minimal and gated.** Name, phone, address only. Stored once on `customers`; the
   accountant role never receives them (API strips them, not just the UI). Proposal §8.
9. **Unknown is a state, not an error.** An unrecognised PostEx status code, an unmatched parcel,
   a COD mismatch: each lands in the reconciliation queue for a person. Sync never crashes on
   data it doesn't understand.
10. **No invented numbers.** A tile with no data shows "—", as the overview does today.

### Conventions

- Migrations: plain numbered SQL in `backend/migrations/NNNN_name.sql`, applied by a small runner
  on `postgres.js` with a `schema_migrations` table and a Postgres advisory lock. Forward only.
  Numbers in this plan are indicative; steps that add a table without one (C4, D1) take the next
  free number when they land.
- Modules live in `backend/src/modules/<name>/` with `repo.ts` (SQL), `service.ts` (rules),
  `routes.ts` (HTTP, zod-validated). Integrations stay in `src/integrations/`.
- Tests: Vitest. Integration tests run against a Neon branch (`DATABASE_URL_TEST`), never the
  main branch. PostEx and Shopify tests use **recorded real responses** in `test/fixtures/`.
- Frontend: React Router, TanStack Query, Recharts. One page per module, one query hook per
  endpoint in `src/lib/queries/`.
- Every step ends with `npm run typecheck`, `npm test` (backend) and `npm run build`,
  `npm run lint` (frontend) green.

---

## 2. Phase map

Follows proposal §13. Two releases, each signed off before the next phase starts.

| Phase | Steps | Weeks | Ends with |
| --- | --- | --- | --- |
| A. Foundation | A1–A7 | 1 | Schema, users and roles, worker process, deploy on Render |
| B. Orders & parcels | B1–B9 | 1–2 | Both stores and both PostEx accounts syncing, matched, visible |
| C. Returns control | C1–C6 | 2 | Returns register, charges, payouts, reconciliation queue, alerts |
| D. Confirmation desk | D1–D5 | 2 | Agents confirming orders in the platform |
| **Release 1** | R1 | end of week 2 | **Orders, returns and confirmations live** (30% milestone) |
| E. Inventory & purchase | E1–E8 | 3 | Stock ledger with all buckets, consignment, purchase flow |
| F. Sales & PR | F1–F5 | 3 | Consignment invoicing, influencer PR tracking |
| G. Accounting & profit | G1–G9 | 3–4 | Journal, ledgers, P&L, profit dashboards, history import |
| H. UAT & go-live | H1–H5 | 4 | **Full go-live** (after UAT: final 30%) |

---

## Phase A — Foundation (week 1)

### A1. Migration runner and test harness
- `src/db/migrate.ts`, `npm run migrate`, `schema_migrations`, advisory lock so web and worker
  can both start without racing.
- Add Vitest; `npm test` runs unit tests, `npm run test:db` runs against `DATABASE_URL_TEST`.
- Money helper (`src/lib/money.ts`: parse `"1250.00"` → `125000n`, format) and date helper
  (Karachi day boundaries) with unit tests.
- **Done when:** `npm run migrate` on an empty Neon branch creates `schema_migrations`; running it
  twice is a no-op; money/date tests pass.

### A2. Core schema
Migration `0001_core.sql`:
- `stores` (`key`, `label`, `shop_domain`, `currency`) seeded with `nur`, `organics`.
- `postex_accounts` (`key`, `label`, `store_key`) seeded; the account → store link is a row.
- `users`, `user_sessions` (for revocation), `audit_log` (`actor`, `action`, `entity`,
  `entity_id`, `before`, `after`, `at`).
- `sync_runs` (`job`, `scope`, `started_at`, `finished_at`, `status`, `stats jsonb`, `error`) and
  `sync_cursors` (`job`, `scope`, `cursor`).
- **Done when:** migration applies on a fresh branch; seeds present; `/ready` still green.

### A3. Real users and roles
- Replace the env single-user in `src/auth/session.ts` with the `users` table. Password hashing
  with `node:crypto` scrypt (no native build on Render). Keep the `/auth/login` and `/auth/me`
  shapes so the frontend does not change.
- Roles: `owner`, `manager`, `operations`, `agent`, `accountant` (proposal §8). A
  `requireRole(...)` middleware and a `permissions.ts` map of role → capabilities.
- `npm run user:create` CLI for the first owner; env credentials only as a bootstrap when the
  table is empty, and refused in production.
- Frontend: `SessionUser.role` widened; nav items hidden by role.
- **Done when:** owner can sign in from the DB user; an `accountant` token gets 403 on an
  agent-only route; env fallback disabled in production.

### A4. Two-step login for owner and manager
- TOTP (RFC 6238, `otpauth` or ~40 lines on `node:crypto`), enrolment QR on first sign-in,
  recovery codes hashed.
- **Done when:** owner and manager cannot get a session token without a valid code; other roles
  unaffected.

### A5. Audit log helper
- `audit(sql, actor, action, entity, before, after)` used inside the same transaction as the
  change. Required for stock adjustments, manual status changes, cost changes, expenses.
- **Done when:** a helper test shows the audit row rolls back with a failed transaction.

### A6. Worker process and scheduler
- `src/worker.ts`, a second entry point (`npm run worker`) for the Render background worker.
- In-process scheduler: each job is `{ name, everyMs, run }`, guarded by
  `pg_try_advisory_lock` so two instances never run the same job, and recorded in `sync_runs`.
- **No DB-polling job queue** (pg-boss etc.): it keeps Neon awake around the clock and breaks the
  months 1–4 scale-to-zero budget in proposal §10. See risk R3.
- `GET /api/v1/sync/runs` (owner/manager) lists recent runs.
- **Done when:** a no-op job runs on schedule, a second worker instance skips it, and its run
  appears in `sync_runs`.

### A7. Deploy to Render (Singapore)
- `render.yaml`: web service (`npm run build && npm run migrate && npm start`), background
  worker, static site for `frontend/` with `VITE_API_URL`. Health check on `/health`.
- Neon project in Singapore; a `main` branch and a `dev` branch.
- Fix while here: `frontend/src/lib/api.ts` `IntegrationStatus` uses `ready`, backend returns
  `configured`.
- **Done when:** the deployed dashboard signs in over HTTPS and shows all four integrations green.

---

## Phase B — Orders & parcels (weeks 1–2)

### B1. Order schema
Migration `0002_orders.sql`:
- `shopify_raw` (`store_key`, `topic`, `shopify_id`, `webhook_id`, `payload jsonb`, `received_at`).
- `customers` (`id`, normalised phone `+92…` unique, name, city). One row per phone across both
  stores: refusal history is per customer, not per store.
- `orders` (`store_key`, `shopify_order_id`, `name` e.g. `#63648`, `customer_id`,
  `financial_status`, `fulfillment_status`, `cancelled_at`, `total`, `cod_amount`,
  `discount_codes text[]`, `tags text[]`, `city`, `placed_at`, `updated_at_shopify`,
  `confirmation_state`), unique `(store_key, shopify_order_id)` and `(store_key, name)`.
- `order_lines` (`order_id`, `variant_id`, `sku`, `title`, `qty`, `unit_price`, `discount`).
- `products`, `variants` (`store_key`, `shopify_variant_id`, `sku`, `title`, `active`).
- **Done when:** migration applies; constraints reject a duplicate order.

### B2. Shopify order mapper
- `src/integrations/shopify/queries.ts`: one GraphQL fragment for orders (lines, customer
  shipping address, discount codes, tags, cancel reason).
- `src/modules/orders/mapper.ts`: Shopify order → rows, pure function, tested against recorded
  payloads from both stores.
- **Done when:** fixture tests cover a COD order, a cancelled order, a fully discounted PR order
  and an order with a confirmation tag.

### B3. Shopify catch-up poll (15 minutes)
- Job `shopify.orders.poll` per store: `orders(query: "updated_at:>=CURSOR")` with a 10-minute
  overlap, paged, upsert, advance cursor only after commit.
- Products/variants poll hourly.
- **Done when:** first run loads the last 60 days for both stores; second run upserts ~0 rows;
  counts match the Shopify admin for a sample day.

### B4. Shopify webhooks
- `POST /webhooks/shopify/:store` registered with `express.raw()` **before** `express.json()`
  (comment already in `app.ts`). HMAC-SHA256 over the raw body with the store's client secret,
  constant-time compare. Dedupe on `X-Shopify-Webhook-Id`. Store raw, then upsert, answer 200
  fast.
- Topics: `orders/create`, `orders/updated`, `orders/cancelled`, `products/update`,
  `app/uninstalled`. Subscriptions created by `npm run shopify:webhooks` (idempotent).
- **Done when:** a test order on each store appears within seconds; a tampered body gets 401; a
  replayed webhook id changes nothing.

### B5. Parcel schema
Migration `0003_parcels.sql`:
- `postex_raw` (`account_key`, `endpoint`, `tracking_number`, `payload jsonb`, `fetched_at`).
- `parcels` (`account_key`, `tracking_number` unique, `order_ref`, `order_id` nullable,
  `raw_status`, `status` canonical, `cod_amount`, `delivery_fee`, `delivery_tax`,
  `return_fee`, `return_tax`, `city`, `items`, `booked_at`, `picked_at`, `delivered_at`,
  `returned_at`, `last_status_at`, `settled`, `settled_at`, `cpr_number`, `match_state`).
- `parcel_events` (`tracking_number`, `code`, `message`, `occurred_at`), unique on all three.
- `postex_status_codes` (`code`, `canonical`, `is_failed_attempt`, `is_terminal`), seeded from
  the verified codes (`0005` delivered, `0013` failed attempt, `0006` returned to merchant, …).
  Canonical: `booked`, `picked`, `in_transit`, `out_for_delivery`, `attempted`, `delivered`,
  `returning`, `returned`, `cancelled`, `unknown`.
- **Done when:** migration applies; seed covers every code seen in the recorded history.

### B6. PostEx parcel sync
- Job `postex.parcels.list` per account: `listOrders` over a rolling booked-date window
  (last 45 days) to discover new parcels.
- Job `postex.parcels.track`: `trackBulk` for every non-terminal parcel, with adaptive cadence —
  every 10 minutes for `out_for_delivery`/`attempted`, 30 minutes otherwise, daily for parcels
  terminal < 7 days (late fee corrections).
- Status derived from **history codes**, not the label (labels differ between endpoints — README).
  Unknown code → `status = unknown` + reconciliation item.
- Respect the existing 1 req/s throttle; batch size tuned against recorded timings.
- **Done when:** every parcel since 14 May 2026 on the NUR account is in `parcels`; totals
  reproduce proposal §3 (1,073 booked, 117 returned, PKR 27,787 return charges, PKR 209,009
  delivery charges) for 14 May – 19 Sep.

### B7. Parcel ↔ order matching
- Normalise `orderRefNumber` (`#63648`, `63648`, `NUR-63648`) → `(store_key, name)` via the
  account's store.
- Fallback for manual bookings: same store, COD amount equal, city equal, booked within 3 days of
  the order, unique candidate only → `match_state = 'suggested'`; anything else →
  `unmatched` into the queue. A person confirms suggestions.
- **Done when:** ≥ 95% of NUR parcels auto-match (proposal §9 measured 95.4%); every other parcel
  is in the queue, none silently dropped.

### B8. Orders and shipments API
- `GET /orders` (filters: store, status, city, date, confirmation state, search by
  name/phone/tracking), `GET /orders/:id` with lines, parcel, timeline, charges.
- `GET /parcels` (filters: status, city, store, date, days in transit).
- PII stripped for `accountant`.
- **Done when:** the NUR order `#63648`-style lookup returns order + parcel + timeline in one call;
  an accountant response has no phone or address field.

### B9. Orders and shipments pages
- Frontend: add React Router, TanStack Query; pages `/orders`, `/orders/:id`, `/shipments`.
  Parcel timeline component (PostEx events next to Shopify events).
- **Done when:** search by order number, tracking number or phone works on a phone-width screen.

---

## Phase C — PostEx logistics & returns control (week 2)

### C1. Failed deliveries
- `parcel_attempts` view: each `is_failed_attempt` event with the reason parsed from the message
  (`RFD(REFUSED TO RECEIVE)` → `refused`, not available, incomplete address, wants to open).
- **Done when:** the Shipments page filters by reason and shows attempt counts.

### C2. Returns register
- Migration `0004_returns.sql`: `returns` (`parcel_id`, `reason`, `refused_at`, `returned_to_merchant_at`, `return_fee`,
  `checked_in_at`, `checked_in_by`, `condition` `restocked|damaged`, `notes`).
- Created automatically when a parcel reaches `returned`. Check-in is a warehouse action
  (operations role) and later drives the stock move (E3).
- **Done when:** all 117 historical returns are in the register with fee and dates; check-in
  writes an audit row.

### C3. COD payouts
- Job `postex.payments`: `paymentStatus` for delivered, unsettled parcels (daily, oldest first),
  storing `settled`, `settlementDate`, `cpr1`.
- `cpr_receipts` grouped view: one row per CPR with its parcels and total.
- Ageing buckets 0–7, 8–14, 15–30, 30+ days (proposal §6.5).
- **Done when:** the sample from proposal §3 (delivered 27 June, settled 2 July) shows correctly;
  "cash with PostEx" has a real number.

### C4. Reconciliation queue
- `recon_items` (`kind`, `entity`, `entity_id`, `detail jsonb`, `state` open/resolved/ignored,
  `resolved_by`, `resolution`). Kinds: `parcel_unmatched`, `match_suggested`, `cod_mismatch`
  (parcel COD ≠ order outstanding), `possible_duplicate` (two live parcels, one order),
  `stuck_in_transit`, `unknown_status`, `return_not_checked_in`, `payout_overdue`.
- Generated by an hourly job; items resolve themselves when the condition clears.
- **Done when:** each kind has a test that creates and clears it; queue page lets a manager link a
  parcel to an order.

### C5. Alerts
- Rules from proposal §6.6: return delivered back but not checked in after N days, parcel stuck
  longer than N days, payout overdue > 14 days, sync job failing twice in a row, unknown status.
- Shown as a badge + list in the dashboard; email later if asked (not in scope).
- **Done when:** thresholds are editable in settings and each alert links to its item.

### C6. First dashboard
- Overview tiles become real: delivered revenue, return rate, delivery success rate, cash with
  PostEx. Net profit stays "—" until G7.
- Returns-by-city chart (Recharts, chart tokens already in `index.css`), charges by month.
- **Done when:** tiles for 14 May – 19 Sep match proposal §3 figures.

---

## Phase D — Order confirmation desk (week 2)

### D1. Confirmation model
- `confirmations` (`order_id`, `attempt`, `agent_id`, `channel` whatsapp/call, `outcome`
  confirmed/no_answer/changed/cancelled, `reason`, `at`).
- `orders.confirmation_state`: `pending`, `confirmed`, `no_answer`, `unreachable`, `cancelled`.
- Import existing confirmation tags from Shopify on first load (proposal §6.4).
- **Done when:** historical orders carry the state implied by their tags.

### D2. Queue and customer history
- `GET /confirmations/queue`: COD orders from both stores, not yet confirmed, oldest first,
  `no_answer` returning after the retry delay; after N attempts → `unreachable` for a manager.
- Each row: items, amount, city, customer's delivered/refused counts by phone, city return rate,
  repeat-refuser flag.
- **Done when:** a new Shopify order appears in the queue within seconds of the webhook.

### D3. Agent actions
- WhatsApp click-to-chat (`https://wa.me/<phone>?text=<template>`), message template per store in
  settings; `tel:` link for calls. One click to record the outcome.
- Optional: write a `confirmed` tag back to Shopify (needs `write_orders`; off by default).
- **Done when:** an agent can work the queue end to end on a phone.

### D4. Release for dispatch
- "Ready to book" list = confirmed, no parcel yet. When B7 matches a parcel the order moves to
  dispatched automatically.
- Alerts: confirmed and not booked within 24 h; parcel booked for a cancelled order.
- **Done when:** both alerts fire in tests.

### D5. Agent performance
- Confirmation rate and median time-to-confirm by agent, unreachable rate, confirmed-then-refused.
- **Done when:** report page shows per-agent figures for a date range.

### R1. Release 1 — orders, returns, confirmations
- Staff accounts created, short guide for agents and warehouse check-in.
- Two working days of parallel run against the manual sheet.
- **Done when:** client signs off; 30% milestone invoiced.

---

## Phase E — Inventory & purchase (week 3)

### E1. Locations and the stock ledger
Migration `0005_inventory.sql`:
- `locations` (`warehouse`, one per retail partner, virtual `reserved`, `with_postex`,
  `coming_back`, `damaged`, `pr_marketing`, `sold`).
- `stock_movements` (`variant_id`, `from_location`, `to_location`, `qty`, `reason`,
  `source_type`, `source_id`, `unit_cost`, `actor`, `at`), unique `(source_type, source_id,
  variant_id, from_location, to_location)` so sync-driven moves are idempotent.
- `stock_balances` view (sum of movements), days-of-cover from delivered sales.
- **Done when:** a movement cannot be updated or deleted (trigger); balances are correct for a
  scripted scenario.

### E2. SKU mapping across stores
- One internal `items` catalogue; each store's variants map to an item. Juggun's Organics SKUs
  assigned here with the client (proposal §11 item 7). Unmapped variants → recon item.
- **Done when:** every variant sold in the last 60 days maps to an item.

### E3. Stock follows the parcel
- Rules from proposal §6.2 as one pure function (order/parcel event → movements):
  order placed → `warehouse → reserved`; cancelled before dispatch → back; parcel picked →
  `reserved → with_postex`; delivered → `with_postex → sold`; failed/returning →
  `with_postex → coming_back`; return checked in → `coming_back → warehouse | damaged`.
- Backfill replays history in event order.
- **Done when:** replaying all historical events twice gives identical balances; each of the
  paths in proposal §2's diagram has a test.

### E4. Adjustments and counts
- Physical count, damage, write-off: reason and user required, audited.
- **Done when:** a count creates the difference as a movement, not an overwrite.

### E5. Consignment transfers and partner sales import
- `partners` (grocery/retail), transfer `warehouse → partner`.
- Partner sheet import: downloadable CSV/XLSX template, preview with validation, then commit
  (`partner → sold` movements + sale rows for F1).
- **Done when:** a sample partner sheet imports, and re-importing the same file is rejected.

### E6. Purchase: vendors, requests, quotations, POs
Migration `0006_purchase.sql`: `vendors`, `purchase_requests`, `quotations`, `purchase_orders`,
`po_lines`. Reorder suggestions from delivered-sales velocity (not placed orders).
- **Done when:** request → quote comparison → PO flow works for one vendor.

### E7. Goods receipt and cost history
- Receipt against a PO, partial receipts, `→ warehouse` movements with `unit_cost`.
- `item_costs` (`item_id`, `cost`, `effective_from`); opening costs imported from the client's
  spreadsheet with their dates (proposal §11 item 6).
- **Done when:** cost at a past date returns the cost in force on that date.

### E8. Opening stock and optional Shopify stock sync
- Import opening counts (proposal §11 item 11) as dated opening movements.
- Stock write-back to Shopify behind a per-store flag, **off** until the client confirms counts
  match (proposal §6.2 step 6). Needs `write_inventory`.
- **Done when:** opening balances load; write-back is a dry-run diff until switched on.

---

## Phase F — Sales & influencer PR (week 3)

### F1. Sales records
- Online sale recognised on `delivered` only; refusals and cancellations never count
  (proposal §6.3). Consignment sale from partner import.
- Sales by brand, store, channel, product, city, partner.
- **Done when:** delivered revenue for 14 May – 19 Sep equals PKR 2.16M collected on 877 parcels.

### F2. Consignment invoices and partner payments
- Invoice per partner import; payments recorded against invoices; partner balance.
- **Done when:** a partner's balance = invoices − payments, with a statement view.

### F3. Influencer list and PR sends
Migration `0007_pr.sql`: `influencers` (handle, name, city, followers, niche), `pr_sends`
(influencer, items, parcel, cost), `pr_posts` (link, date, type reel/story/post).
- Creating a send reserves stock; units leave as `→ pr_marketing`, never as sales.
- **Done when:** a PR send moves stock to `pr_marketing` and does not change return rate.

### F4. Detect PR sends made outside the platform
- Shopify orders tagged `PR` or 100% discounted; PostEx parcels with `invoicePayment = 0`
  (54 found in proposal §6.8). Suggested as PR sends for a person to confirm.
- **Done when:** the 54 zero-value parcels appear as suggestions; confirmed ones book product
  cost + PostEx charge as marketing expense (G3).

### F5. Influencer results
- Discount code → influencer; orders using it credited. Cost per influencer/campaign vs sales.
- **Done when:** the report shows cost, posts and attributed delivered sales per influencer.

---

## Phase G — Accounting & profit (weeks 3–4)

### G1. Chart of accounts and journal
Migration `0008_accounting.sql`: `accounts` (both brands as dimensions, not duplicated charts),
`journal_entries`, `journal_lines` (`account_id`, `debit`, `credit`, `store_key`), balanced by a
deferred constraint trigger. Append-only like the stock ledger.
- **Done when:** an unbalanced entry fails to commit.

### G2. Posting rules
One function per business event, each producing a journal entry, each tested:
- Delivered parcel → receivable from PostEx / sales, COGS / inventory at cost in force.
- PostEx delivery and return charges (+16% tax) → expense / payable to PostEx.
- CPR payout → bank / receivable from PostEx (net of charges).
- Goods receipt, vendor bill, vendor payment; consignment invoice and payment.
- PR send → marketing expense / inventory; damaged return → write-off.
- **Done when:** replaying all history gives a trial balance that balances and a PostEx
  receivable equal to "cash with PostEx" from C3.

### G3. Expenses
- Categories (ads, salaries, rent, packaging…), entry with receipt note, audited.
- **Done when:** expenses appear in P&L by month and brand.

### G4. Customer invoicing and sales tax
- Invoice per delivered order and per consignment sale; sales tax calculated and tracked
  (no FBR filing — exclusion).
- **Done when:** tax totals by month export to CSV for the accountant.

### G5. Bank statement import and matching
- CSV import; auto-match to CPR payouts and partner/vendor payments by amount and date;
  unmatched lines in the reconciliation queue.
- **Done when:** a real statement month matches its CPR deposits.

### G6. Reports and month-end close
- General Ledger, Trial Balance, Partner Ledger (customers, vendors, retail partners, PostEx),
  Profit & Loss by month/brand/store.
- Month close on the 5th of the following month: `periods.closed_at`; postings into a closed
  period are rejected and must go in as adjustments in the open period.
- Opening balances from the accountant (proposal §11 item 15).
- **Done when:** closing September blocks a back-dated posting and the adjustment shows in October.

### G7. Profit dashboards
- Net profit tile, order funnel (placed → confirmed → dispatched → delivered/returned, count and
  value), profit per parcel shipped, profit by product **after returns**, by city, cash-flow ageing,
  inventory value and low stock with days of cover.
- **Done when:** every figure drills down to the orders, parcels or bills behind it.

### G8. History import
- Shopify orders older than 60 days: client's CSV export importer (proposal §11 item 2), and
  `read_all_orders` if approved — same mapper as B2.
- Any earlier PostEx account (proposal §11 item 5): add a row to `postex_accounts`, run B6.
- PostEx portal statements to check deductions the API does not show (proposal §11 item 4).
- **Done when:** history imports into a Neon branch first, totals are checked with the client,
  then it is replayed on main.

### G9. Monthly full export
- Job on the 1st: every table to CSV/Parquet in a zip, downloadable by the owner (proposal §8,
  §17: "your data stays yours").
- **Done when:** the export restores into an empty database with matching row counts.

---

## Phase H — UAT and go-live (week 4)

- **H1. Security pass:** role matrix test for every route, PII stripping, rate limit on login,
  secrets only in Render env, `helmet` CSP on the static site.
- **H2. Performance:** list endpoints paged and indexed; overview under 1 s on a warm Neon.
- **H3. Monitoring:** daily sync health check, failed-job alert, unknown-status alert (feeds the
  maintenance scope in proposal §16).
- **H4. UAT:** scripted scenarios per module with the client's team; fixes; training and short
  how-to guides per role.
- **H5. Full go-live:** switch Neon to always-on from month 5 as budgeted; final 30% milestone.

---

## 3. Client inputs this plan waits on

From proposal §11, mapped to the step that blocks without them.

| Input | Needed by |
| --- | --- |
| Product cost prices with dates | E7, G2 (profit is "—" until then) |
| Full order CSV per store; `read_all_orders` request | G8 |
| PostEx portal access or last two statements | G8 check |
| Earlier PostEx account token, if any | G8 |
| Juggun's Organics SKUs | E2 |
| Team members, emails, roles | A3, R1 |
| Business WhatsApp number(s) and message wording | D3 |
| Opening stock count | E8 |
| Retail partner list with stock held | E5 |
| Vendor list and open POs | E6 |
| Influencer list and discount codes | F3, F5 |
| Opening balances and expense categories | G3, G6 |

---

## 4. Risks and decisions

- **R1. PostEx has no test environment.** Mitigated by read-only client, recorded fixtures, and
  `POSTEX_ALLOW_WRITES` refused outside production. Booking stays out of scope.
- **R2. PostEx field and status drift.** Labels already differ between endpoints. We key on
  history codes, keep raw payloads, and send unknown codes to the queue instead of guessing.
- **R3. Neon scale-to-zero vs polling.** The months 1–4 budget assumes ~8 active DB hours a day.
  A 10-minute poll wakes Neon all day. Decision: poll PostEx every 10–30 minutes between
  08:00 and 23:00 Karachi, hourly overnight; webhooks still wake the DB when orders arrive. Measure
  active hours in week 2 and report before month 5.
- **R4. Shopify 60-day window.** Older orders depend on CSV exports or `read_all_orders`
  approval; history import (G8) is built to run from either.
- **R5. Protected customer data.** Name, phone, address need Shopify's protected data access,
  already switched on for both apps. Any new scope (`write_orders`, `write_inventory`) is added
  only when its feature is turned on.
- **R6. Matching below 95%.** Manual bookings with non-Shopify references go to suggested/unmatched,
  never auto-linked on weak evidence.
- **R7. Four weeks is tight for eight modules.** Release 1 scope is fixed (B, C, D). If week 3
  slips, the cut order is: E8 write-back, G5 bank matching, F5 reports — all already optional
  or reportable later without changing the ledgers.
