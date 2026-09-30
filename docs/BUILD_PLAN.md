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

These follow from 1.1–1.9 and shape the phase order, so they are stated once here.

- **Ledgers exist before the first sync.** The delivered handler (1.6) writes a stock move (1.4)
  and a journal entry (1.5) from the first PostEx sync in week 1. So `locations`, `stock_moves`,
  `accounts` and `journal_*` are foundation work (A8), not week 3 work. Phases E and G add flows
  on top; they do not introduce the ledgers.
- **One transition handler.** `src/modules/shipments/transitions.ts` is the only code that turns
  a shipment status change into stock moves and journal entries. Sync, backfill and replay all go
  through it. Nothing else posts revenue.
- **Reservation is not a location.** It is not in the 1.4 list, and a reserved unit has not
  moved. `available = warehouse quant − open reservations`, where open reservations are the lines
  of orders that are placed/confirmed with no shipment picked up yet. A view, never a move.
- **Missing inputs do not block the ledger.** Product costs and opening stock arrive later
  (§3). A delivery before costs exist posts the sale and opens a `cost_missing` review item; COGS
  is posted, dated at delivery, once the cost lands. Warehouse quants may go negative until
  opening stock is loaded as dated opening moves; negatives are flagged, never clamped.
- **Raw payloads are kept.** Every Shopify payload and PostEx response is stored as received
  (`jsonb`) before it is mapped. PostEx has no sandbox and no history beyond what it returns
  today, so raw rows are the only replay source.
- **Corrections are reversals.** Stock moves and journal lines are never updated or deleted
  (enforced by trigger). A correction is a new reversing row with a reason and an actor.
- **Unknown is a state, not an error.** An unrecognised PostEx status code, an unmatched
  shipment, a COD mismatch: each opens a review item. Sync never crashes on data it does not
  understand.
- **No invented numbers.** A tile with no data shows "—", as the overview does today.

### Conventions

- Migrations: plain numbered SQL in `backend/migrations/NNNN_name.sql`, applied by a small runner
  on `postgres.js` with a `schema_migrations` table and a Postgres advisory lock. Forward only.
  Numbers in this plan are indicative; steps that add a table take the next free number.
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
| A. Foundation | A1–A8 | 1 | Schema, both ledgers, users and roles, worker process, deploy on Render |
| B. Orders & shipments | B1–B9 | 1–2 | Both stores and both PostEx accounts syncing, matched, posting to the ledgers |
| C. Returns control | C1–C6 | 2 | Returns register, charges, payouts, review queue, alerts |
| D. Confirmation desk | D1–D5 | 2 | Agents confirming orders in the platform |
| **Release 1** | R1 | end of week 2 | **Orders, returns and confirmations live** (30% milestone) |
| E. Inventory & purchase | E1–E7 | 3 | Partners, counts, consignment, purchase flow, costs, opening stock |
| F. Sales & PR | F1–F5 | 3 | Consignment invoicing, influencer PR tracking |
| G. Accounting & profit | G1–G8 | 3–4 | Remaining postings, ledgers, P&L, profit dashboards, history import |
| H. UAT & go-live | H1–H5 | 4 | **Full go-live** (after UAT: final 30%) |

---

## Phase A — Foundation (week 1)

### A1. Migration runner and test harness
- `src/db/migrate.ts`, `npm run migrate`, `schema_migrations`, advisory lock so web and worker
  can both start without racing.
- Add Vitest; `npm test` runs unit tests, `npm run test:db` runs against `DATABASE_URL_TEST`.
- `src/lib/money.ts` (1.1: parse `"1250.00"` → `125000n`, format for display) and
  `src/lib/time.ts` (1.2: Karachi day/month boundaries, `parseKarachiLocal()` for PostEx strings),
  both with unit tests. The only two places those conversions happen.
- **Done when:** `npm run migrate` on an empty Neon branch creates `schema_migrations`; running it
  twice is a no-op; money/time tests pass, including a PostEx timestamp across midnight UTC.

### A2. Core schema
Migration `0001_core.sql`:
- `stores` (`id`, `key`, `label`, `shop_domain`, `currency`) seeded with `nur`, `organics`.
- `postex_accounts` (`id`, `key`, `label`, `store_id`) seeded; the account → store link is a row.
- `users`, `user_sessions` (for revocation), `audit_log` (`actor`, `action`, `entity`,
  `entity_id`, `before`, `after`, `at`).
- `sync_runs` (`job`, `scope`, `started_at`, `finished_at`, `status`, `stats jsonb`, `error`) and
  `sync_cursors` (`job`, `scope`, `cursor`).
- `webhook_events` (`store_id`, `shopify_event_id`, `topic`, `received_at`), unique
  `(store_id, shopify_event_id)` (1.7).
- `review_items` (`kind`, `entity`, `entity_id`, `detail jsonb`, `state` open/resolved/ignored,
  `resolved_by`, `resolution`), the one queue every "unknown" lands in.
- **Done when:** migration applies on a fresh branch; seeds present; `/ready` still green.

### A3. Real users and roles
- Replace the env single-user in `src/auth/session.ts` with the `users` table. Password hashing
  with `node:crypto` scrypt (no native build on Render). Keep the `/auth/login` and `/auth/me`
  shapes so the frontend does not change.
- Roles: `owner`, `manager`, `operations`, `agent`, `accountant` (proposal §8). A
  `requireRole(...)` middleware and a `permissions.ts` map of role → capabilities.
- Response serialisers take the role and drop PII fields for `accountant` (1.9). Routes never
  hand-pick fields.
- `npm run user:create` CLI for the first owner; env credentials only as a bootstrap when the
  table is empty, and refused in production.
- Frontend: `SessionUser.role` widened; nav items hidden by role.
- **Done when:** owner can sign in from the DB user; an `accountant` token gets 403 on an
  agent-only route; env fallback disabled in production.

### A4. Two-step login for owner and manager
- TOTP (RFC 6238) on `node:crypto`, enrolment QR on first sign-in, recovery codes hashed.
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

### A8. Ledger foundations (stock and money)
Migration `0002_ledgers.sql`. Schema and write helpers only; the flows come with their modules.
- `locations` (`id`, `type` per 1.4, `name`, `partner_id` nullable), seeded with one each of
  `warehouse`, `in_transit`, `returning`, `customer`, `marketing`, `damaged`, `supplier`,
  `adjustment`. `partner` rows are added in E1.
- `stock_moves` exactly as 1.4, plus `unit_cost` and a unique
  `(ref_type, ref_id, variant_id, from_location, to_location)` so sync-driven moves are
  idempotent. `qty > 0`, `from ≠ to`, no UPDATE/DELETE (trigger).
- `stock_quants` (`variant_id`, `location_id`, `qty`) maintained in the same transaction as each
  move; `npm run stock:rebuild` recomputes it from `stock_moves` and diffs.
- `accounts` (chart of accounts, both brands as a `store_id` dimension on lines rather than two
  charts), `journal_entries` (`date`, `memo`, `ref_type`, `ref_id`, `period`), `journal_lines`
  (`account_id`, `debit`, `credit`, `store_id`). A deferred constraint trigger rejects any entry
  whose lines do not balance. No UPDATE/DELETE.
- `moveStock()` and `postJournal()` in `src/ledgers/`: the only way to write either table.
- **Done when:** an unbalanced entry fails to commit; a move without a counterpart cannot be
  expressed; `stock:rebuild` on a scripted scenario reports zero diff.

---

## Phase B — Orders & shipments (weeks 1–2)

### B1. Order schema
Migration `0003_orders.sql`:
- `shopify_raw` (`store_id`, `topic`, `shopify_id`, `payload jsonb`, `received_at`).
- `customers` (`id`, `phone_e164` unique, name, address, city). One row per phone across both
  stores: refusal history is per customer, not per store (1.9).
- `orders` (`store_id`, `shopify_order_id`, `name` e.g. `#63648`, `customer_id`,
  `financial_status`, `fulfillment_status`, `cancelled_at`, `total`, `cod_amount`,
  `discount_codes text[]`, `tags text[]`, `city`, `placed_at`, `updated_at_shopify`, `state`),
  unique `(store_id, shopify_order_id)` and `(store_id, name)`.
- `order_lines` (`order_id`, `variant_id`, `sku`, `title`, `qty`, `unit_price`, `discount`).
- `products`, `variants` (`store_id`, `shopify_variant_id`, `sku`, `title`, `active`), unique
  `(store_id, shopify_variant_id)`.
- `orders.state` is written **only** by `refreshOrderState(orderId)`, which derives it from the
  latest confirmation, the shipment status and the money postings (1.3). No route sets it.
- **Done when:** migration applies; constraints reject a duplicate order; a test shows
  `refreshOrderState` is the only writer (a source-grep test in `npm test`).

### B2. Shopify order mapper
- `src/integrations/shopify/queries.ts`: one GraphQL fragment for orders (lines, shipping
  address, discount codes, tags, cancel reason).
- `src/modules/orders/mapper.ts`: Shopify order → rows, pure function, tested against recorded
  payloads from both stores. Phone normalised to `+92…` here.
- **Done when:** fixture tests cover a COD order, a cancelled order, a fully discounted PR order
  and an order with a confirmation tag.

### B3. Shopify catch-up poll (15 minutes)
- Job `shopify.orders.poll` per store: `orders(query: "updated_at:>=CURSOR")` with a 10-minute
  overlap, paged, upsert, advance cursor only after commit.
- Products/variants poll hourly.
- **Done when:** first run loads the last 60 days for both stores; the 1.7 test passes: running
  the poll twice leaves every table byte-identical (row hashes compared); counts match the
  Shopify admin for a sample day.

### B4. Shopify webhooks
- `POST /webhooks/shopify/:store` registered with `express.raw()` **before** `express.json()`
  (comment already in `app.ts`). HMAC-SHA256 over the raw body with the store's client secret,
  constant-time compare. Insert into `webhook_events` on `X-Shopify-Event-Id`; on conflict, answer
  200 and do nothing. Store raw, upsert, answer 200 fast.
- Topics: `orders/create`, `orders/updated`, `orders/cancelled`, `products/update`,
  `app/uninstalled`. Subscriptions created by `npm run shopify:webhooks` (idempotent).
- **Done when:** a test order on each store appears within seconds; a tampered body gets 401; a
  replayed event id changes nothing.

### B5. Shipment schema and PostEx mapper
Migration `0004_shipments.sql`:
- `postex_raw` (`postex_account_id`, `endpoint`, `tracking_number`, `payload jsonb`, `fetched_at`).
- `shipments` (`postex_account_id`, `tracking_number`, `order_ref`, `order_id` nullable,
  `raw_status`, `status` canonical, `cod_amount`, `delivery_fee`, `delivery_tax`, `return_fee`,
  `return_tax`, `city`, `items`, `booked_at`, `picked_at`, `delivered_at`, `returned_at`,
  `last_status_at`, `cod_payout_id` nullable, `match_state`), unique
  `(postex_account_id, tracking_number)` (1.8).
- `shipment_events` (`shipment_id`, `code`, `message`, `occurred_at`), unique on all four.
- `postex_status_codes` (`code`, `canonical`, `is_failed_attempt`, `is_terminal`), seeded from
  the verified codes (`0005` delivered, `0013` failed attempt, `0006` returned to merchant, …).
  Canonical: `booked`, `picked`, `in_transit`, `out_for_delivery`, `attempted`, `delivered`,
  `returning`, `returned`, `cancelled`, `unknown`.
- `src/integrations/postex/mapper.ts`: PostEx parcel → rows. Every PostEx timestamp goes through
  `parseKarachiLocal()` here and nowhere else (1.2). Amounts through `money.ts`.
- **Done when:** migration applies; seed covers every code seen in the recorded history; mapper
  fixture tests pass.

### B6. PostEx sync and the transition handler
- Job `postex.shipments.list` per account: `listOrders` over a rolling booked-date window
  (last 45 days) to discover new shipments.
- Job `postex.shipments.track`: `trackBulk` for every non-terminal shipment, with adaptive cadence:
  every 10 minutes for `out_for_delivery`/`attempted`, 30 minutes otherwise, daily for shipments
  terminal < 7 days (late fee corrections).
- Status derived from **history codes**, not the label (labels differ between endpoints, see
  README). Unknown code → `status = unknown` + review item.
- `transitions.ts` (1.10), one function per edge, each in one transaction with the status update:

  | Transition | Stock (1.4) | Journal (1.5) |
  | --- | --- | --- |
  | picked up by PostEx | `warehouse → in_transit` | none |
  | failed attempt, retry | none | none |
  | **delivered** | `in_transit → customer` | sale, COGS (if cost known), forward charge + tax |
  | return started | `in_transit → returning` | none |
  | returned to merchant | none (not yet checked in) | return charge + tax |
  | checked in (C2) | `returning → warehouse` or `→ damaged` | damaged: write-off |

  The **delivered** edge is the only place revenue is recognised (1.6).
- **Done when:** every shipment since 14 May 2026 on the NUR account is in `shipments`; running
  the full sync twice leaves shipments, events, stock moves and journal identical; totals
  reproduce proposal §3 for 14 May – 19 Sep (1,073 booked, 117 returned, PKR 27,787 return
  charges, PKR 209,009 delivery charges); a test proves an in-transit order posts zero revenue.

### B7. Shipment ↔ order matching
- Normalise `orderRefNumber` (`#63648`, `63648`, `NUR-63648`) → `(store_id, name)` via the
  account's store.
- Fallback for manual bookings: same store, COD amount equal, city equal, booked within 3 days of
  the order, unique candidate only → `match_state = 'suggested'`; anything else → `unmatched`
  review item. A person confirms suggestions.
- Stock moves need order lines, so an unmatched shipment's transitions are held and replayed
  through `transitions.ts` once it is linked.
- **Done when:** ≥ 95% of NUR shipments auto-match (proposal §9 measured 95.4%); every other one
  is in the queue, none silently dropped; linking one replays its held transitions.

### B8. Orders and shipments API
- `GET /orders` (filters: store, state, city, date, search by name/phone/tracking),
  `GET /orders/:id` with lines, shipment, timeline, charges.
- `GET /shipments` (filters: status, city, store, date, days in transit).
- Serialised through A3's role-aware serialisers.
- **Done when:** an order lookup returns order + shipment + timeline in one call; an accountant
  response has no phone or address field (API test, not UI).

### B9. Orders and shipments pages
- Frontend: add React Router, TanStack Query; pages `/orders`, `/orders/:id`, `/shipments`.
  Timeline component (PostEx events next to Shopify events).
- **Done when:** search by order number, tracking number or phone works on a phone-width screen.

---

## Phase C — PostEx logistics & returns control (week 2)

### C1. Failed deliveries
- `shipment_attempts` view: each `is_failed_attempt` event with the reason parsed from the message
  (`RFD(REFUSED TO RECEIVE)` → `refused`, not available, incomplete address, wants to open).
- **Done when:** the Shipments page filters by reason and shows attempt counts.

### C2. Returns register and warehouse check-in
- Migration: `returns` (`shipment_id`, `reason`, `refused_at`, `returned_to_merchant_at`,
  `return_fee`, `checked_in_at`, `checked_in_by`, `condition` `restocked|damaged`, `notes`).
- Created when a shipment reaches `returned`. Check-in (operations role) calls the
  `checked in` edge in `transitions.ts`, audited.
- **Done when:** all 117 historical returns are in the register with fee and dates; the
  `returning` location holds exactly the units of returns not yet checked in.

### C3. COD payouts
- Migration: `cod_payouts` (`postex_account_id`, `cpr_number`, `settled_at`, `amount`), unique
  `(postex_account_id, cpr_number)`; `shipments.cod_payout_id` links each shipment to its payout.
- Job `postex.payments`: `paymentStatus` for delivered, unsettled shipments (daily, oldest first).
  A new payout posts PostEx receivable → bank.
- Ageing buckets 0–7, 8–14, 15–30, 30+ Karachi days (proposal §6.5).
- **Done when:** the sample from proposal §3 (delivered 27 June, settled 2 July) shows correctly;
  "cash with PostEx" equals the PostEx receivable balance in the journal.

### C4. Review queue
- Kinds in `review_items`: `shipment_unmatched`, `match_suggested`, `cod_mismatch` (shipment COD ≠
  order outstanding), `possible_duplicate` (two live shipments, one order), `stuck_in_transit`,
  `unknown_status`, `return_not_checked_in`, `payout_overdue`, `cost_missing`,
  `negative_stock`, `variant_unmapped`.
- Generated by an hourly job; items resolve themselves when the condition clears.
- **Done when:** each kind has a test that creates and clears it; queue page lets a manager link a
  shipment to an order.

### C5. Alerts
- Rules from proposal §6.6: return delivered back but not checked in after N days, shipment stuck
  longer than N days, payout overdue > 14 days, sync job failing twice in a row, unknown status.
- Shown as a badge + list in the dashboard; email later if asked (not in scope).
- **Done when:** thresholds are editable in settings and each alert links to its item.

### C6. First dashboard
- Overview tiles become real: delivered revenue (sales account in the journal), return rate,
  delivery success rate, cash with PostEx (receivable). Net profit stays "—" until costs load.
- Returns-by-city chart (Recharts, chart tokens already in `index.css`), charges by month.
- **Done when:** tiles for 14 May – 19 Sep match proposal §3 figures.

---

## Phase D — Order confirmation desk (week 2)

### D1. Confirmation model
- Migration: `confirmations` (`order_id`, `attempt`, `agent_id`, `channel` whatsapp/call,
  `outcome` confirmed/no_answer/changed/cancelled, `reason`, `at`). The confirmation part of
  `orders.state` is derived from these rows by `refreshOrderState`, never set directly.
- Import existing confirmation tags from Shopify on first load (proposal §6.4) as historical
  confirmation rows.
- **Done when:** historical orders carry the state implied by their tags.

### D2. Queue and customer history
- `GET /confirmations/queue`: COD orders from both stores, not yet confirmed, oldest first,
  `no_answer` returning after the retry delay; after N attempts → `unreachable` for a manager.
- Each row: items, amount, city, the customer's delivered/refused counts by `phone_e164`, city
  return rate, repeat-refuser flag.
- **Done when:** a new Shopify order appears in the queue within seconds of the webhook.

### D3. Agent actions
- WhatsApp click-to-chat (`https://wa.me/<phone>?text=<template>`), message template per store in
  settings; `tel:` link for calls. One click to record the outcome.
- Optional: write a `confirmed` tag back to Shopify (needs `write_orders`; off by default).
- **Done when:** an agent can work the queue end to end on a phone.

### D4. Release for dispatch
- "Ready to book" list = confirmed, no shipment yet. When B7 matches a shipment the order moves to
  dispatched automatically.
- Alerts: confirmed and not booked within one Karachi business day; shipment booked for a
  cancelled order.
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

The ledger has existed since A8 and has been moving shipment stock since B6. This phase adds the
remaining locations and flows.

### E1. Partners and stock views
- Migration: `partners`; each partner gets a `partner` location.
- Stock page: quants per (variant, location); `available` = warehouse − open reservations
  (1.10); days of cover from delivered sales; low-stock thresholds.
- **Done when:** the stock page and `stock:rebuild` agree for every (variant, location).

### E2. Catalogue across stores
- Variants stay per store (1.8). An `items` table links variants of both stores **only** where the
  SKU genuinely matches; otherwise each variant is its own item. Juggun's Organics SKUs assigned
  here with the client (proposal §11 item 7). Unmapped variants → `variant_unmapped`.
- **Done when:** every variant sold in the last 60 days is mapped or in the queue.

### E3. Replay and path tests
- `npm run ledger:replay` rebuilds all shipment-driven moves and postings from `shipment_events`
  through `transitions.ts` on a Neon branch and diffs against main.
- **Done when:** replay twice gives identical results; each path in proposal §2's diagram
  (delivered, cancelled before dispatch, failed then delivered, refused → restocked, refused →
  damaged) has an end-to-end test.

### E4. Adjustments and counts
- Physical count, damage, write-off: reason and user required, audited, against the `adjustment`
  location.
- **Done when:** a count creates the difference as a move to/from `adjustment`, not an overwrite.

### E5. Consignment transfers and partner sales import
- Transfer `warehouse → partner`.
- Partner sheet import: downloadable CSV/XLSX template, preview with validation, then commit
  (`partner → customer` moves + sale postings, F1).
- **Done when:** a sample partner sheet imports, and re-importing the same file is rejected.

### E6. Purchase: vendors, requests, quotations, POs, receipts
- Migration: `vendors`, `purchase_requests`, `quotations`, `purchase_orders`, `po_lines`,
  `goods_receipts`. Reorder suggestions from delivered-sales velocity (not placed orders).
- Receipt against a PO, partial receipts, `supplier → warehouse` moves with `unit_cost`.
- **Done when:** request → quote comparison → PO → partial receipt works for one vendor.

### E7. Costs and opening stock
- `item_costs` (`item_id`, `cost`, `effective_from`); client's cost sheet imported with dates
  (proposal §11 item 6). Loading costs posts the deferred COGS for `cost_missing` items, dated at
  their delivery.
- Opening counts (proposal §11 item 11) as dated `adjustment → warehouse` opening moves; negative
  quants flagged by C4 should clear.
- Stock write-back to Shopify behind a per-store flag, **off** until the client confirms counts
  match (proposal §6.2 step 6). Needs `write_inventory`.
- **Done when:** cost at a past date returns the cost in force on that date; `cost_missing` queue
  is empty; write-back is a dry-run diff until switched on.

---

## Phase F — Sales & influencer PR (week 3)

### F1. Sales reporting
- Sales by brand, store, channel, product, city, partner — queries over the journal (1.5) joined
  to shipments and order lines. No separate sales arithmetic.
- **Done when:** delivered revenue for 14 May – 19 Sep equals PKR 2.16M collected on 877 parcels.

### F2. Consignment invoices and partner payments
- Invoice per partner import (posted), payments recorded against invoices (posted); partner
  balance from the ledger.
- **Done when:** a partner's ledger balance = invoices − payments, with a statement view.

### F3. Influencer list and PR sends
- Migration: `influencers` (handle, name, city, followers, niche), `pr_sends` (influencer, items,
  shipment, cost), `pr_posts` (link, date, type reel/story/post).
- A PR send's units go `warehouse → in_transit → marketing`; its product cost and PostEx charge
  post as marketing expense. PR shipments are excluded from sales, return rate and revenue.
- **Done when:** a PR send ends in `marketing`, posts no revenue, and leaves the return rate
  unchanged.

### F4. Detect PR sends made outside the platform
- Shopify orders tagged `PR` or 100% discounted; PostEx shipments with `invoicePayment = 0`
  (54 found in proposal §6.8). Suggested as PR sends for a person to confirm.
- **Done when:** the 54 zero-value shipments appear as suggestions; confirming one re-routes it
  through the PR edge in `transitions.ts`.

### F5. Influencer results
- Discount code → influencer; delivered orders using it credited. Cost per influencer/campaign vs
  sales.
- **Done when:** the report shows cost, posts and attributed delivered sales per influencer.

---

## Phase G — Accounting & profit (weeks 3–4)

The journal has existed since A8 with shipment, payout, PR and consignment postings. This phase
adds the rest and the reports.

### G1. Remaining posting rules
- Vendor bill (matched to PO and receipt), vendor payment, expenses, customer invoices.
- **Done when:** each rule has a test; the trial balance balances after a full replay.

### G2. Expenses
- Categories (ads, salaries, rent, packaging…), entry with receipt note, audited.
- **Done when:** expenses appear in P&L by month and brand.

### G3. Customer invoicing and sales tax
- Invoice per delivered order and per consignment sale; sales tax calculated and tracked
  (no FBR filing — exclusion).
- **Done when:** tax totals by month export to CSV for the accountant.

### G4. Bank statement import and matching
- CSV import; auto-match to `cod_payouts` and partner/vendor payments by amount and date;
  unmatched lines to the review queue.
- **Done when:** a real statement month matches its CPR deposits.

### G5. Reports and month-end close
- General Ledger, Trial Balance, Partner Ledger (customers, vendors, retail partners, PostEx),
  Profit & Loss by month/brand/store — all queries over `journal_lines`.
- Month close on the 5th of the following month (Karachi): `periods.closed_at`; postings into a
  closed period are rejected and go in as adjustments in the open period.
- Opening balances from the accountant (proposal §11 item 15).
- **Done when:** closing September blocks a back-dated posting and the adjustment shows in October.

### G6. Profit dashboards
- Net profit tile, order funnel (placed → confirmed → dispatched → delivered/returned, count and
  value), profit per shipment, profit by product **after returns**, by city, cash-flow ageing,
  inventory value and low stock with days of cover.
- **Done when:** every figure drills down to the orders, shipments or journal entries behind it.

### G7. History import
- Shopify orders older than 60 days: client's CSV export importer (proposal §11 item 2), and
  `read_all_orders` if approved — same mapper as B2.
- Any earlier PostEx account (proposal §11 item 5): add a `postex_accounts` row, run B6.
- PostEx portal statements to check deductions the API does not show (proposal §11 item 4).
- **Done when:** history imports into a Neon branch first, totals are checked with the client,
  then it is replayed on main.

### G8. Monthly full export
- Job on the 1st: every table to CSV in a zip, downloadable by the owner (proposal §8, §17).
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

From proposal §11, mapped to the step that is incomplete without them. None of them block the
ledgers (1.10).

| Input | Needed by |
| --- | --- |
| Product cost prices with dates | E7 (COGS and profit stay pending until then) |
| Full order CSV per store; `read_all_orders` request | G7 |
| PostEx portal access or last two statements | G7 check |
| Earlier PostEx account token, if any | G7 |
| Juggun's Organics SKUs | E2 |
| Team members, emails, roles | A3, R1 |
| Business WhatsApp number(s) and message wording | D3 |
| Opening stock count | E7 (warehouse quants flagged negative until then) |
| Retail partner list with stock held | E1, E5 |
| Vendor list and open POs | E6 |
| Influencer list and discount codes | F3, F5 |
| Opening balances and expense categories | G2, G5 |

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
  approval; history import (G7) is built to run from either.
- **R5. Protected customer data.** Name, phone, address need Shopify's protected data access,
  already switched on for both apps. Any new scope (`write_orders`, `write_inventory`) is added
  only when its feature is turned on.
- **R6. Matching below 95%.** Manual bookings with non-Shopify references go to suggested/unmatched,
  never auto-linked on weak evidence.
- **R7. Ledgers before their inputs.** Posting from week 1 means COGS and warehouse stock are
  incomplete until costs and opening counts arrive. Handled by `cost_missing` and
  `negative_stock` review items and dated catch-up postings, so nothing is back-edited. If the
  opening count is taken on a different day than the one loaded, the difference shows as an
  adjustment, which is the honest record.
- **R8. Four weeks is tight for eight modules.** Release 1 scope is fixed (B, C, D). If week 3
  slips, the cut order is: E7 write-back, G4 bank matching, F5 reports — all already optional
  or reportable later without changing the ledgers.
