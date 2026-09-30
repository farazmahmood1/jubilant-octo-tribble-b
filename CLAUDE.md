## Project

NUR Organics is the parent of two Shopify D2C brands in Pakistan: NUR by Juggun and
Juggun's Organics. Orders are confirmed by WhatsApp/phone, shipped cash-on-delivery via
PostEx, and also supplied to retail partners on consignment. We are building one platform
that joins Shopify orders, PostEx parcel outcomes, stock and accounting, so profit and
inventory are finally correct.

Two Shopify stores (`nurbyjuggun`, `jugguns-organics`) and two PostEx merchant accounts.
Both are already connected and verified.

## Stack

Backend: Node 24, Express 5, TypeScript strict + NodeNext (import specifiers end in `.js`),
zod, pino, postgres.js against Neon PostgreSQL, jose for JWT. No ORM: hand-written SQL with
typed row interfaces. Tests with `node:test`.

Frontend: Vite, React 19, TypeScript strict, Tailwind v4, shadcn/ui, `@/` path alias.
Note `erasableSyntaxOnly` is on: no constructor parameter properties, no enums.

## Non-negotiable rules

1. PostEx is READ-ONLY. No booking, cancelling, or shipper-advice calls, ever. There is no
   sandbox; a write moves a real parcel and real money. Do not add a write method even
   behind a flag beyond the existing guarded `POSTEX_ALLOW_WRITES`.
2. Never log, return, or commit secrets, tokens, or customer PII beyond what a role allows.
   Test fixtures must have names, phones and addresses masked.
3. Money is integer paisa (`bigint`). Never floating point. Never `numeric` arithmetic in JS.
4. Timestamps are `timestamptz` stored UTC. All business-day logic uses Asia/Karachi via the
   shared helper. PostEx returns offset-less local strings: parse as Asia/Karachi explicitly.
5. Every sync is idempotent, keyed on the external id. Running it twice must change nothing.
6. Stock only ever changes through `stock_moves`. Money only ever changes through
   `journal_lines`. No incrementing quantity columns, no ad-hoc balance updates.
7. Derived state is derived on every read/change. No hand-set status columns.
8. Every financial or destructive action writes to `audit_log` with the actor.
9. Multi-tenant from day one: no Shopify id without a `store_id`, no shipment without a
   `postex_account_id`. Unique constraints are composite.

## Verified PostEx facts (do not re-derive)

Base: `https://api.postex.pk/services/integration/api/order`, `token` header auth.
No webhooks, no sandbox, no published rate limits. We throttle to 1 req/s.
Envelope: `{statusCode, statusMessage, dist}`. List/bulk endpoints wrap rows in
`trackingResponse`.

Fields: `invoicePayment` (COD amount), `transactionFee` / `transactionTax` (forward charge,
16% tax), `reversalFee` / `reversalTax` (return charge), `orderDeliveryDate`,
`statusUpdatedAt`, `transactionStatusHistory[].{code,message,updatedAt}`, `cpr1` / `cpr1Date`
(payout receipt).

Status codes: 0005 delivered, 0013 attempt made (reason RFD refused / CNA customer not
available / ICA incomplete address / OPN wants to open), 0008 under review, 0040 return
initiated, 0006 returned at merchant warehouse, 0002 cancelled by merchant.

Measured on live data (1,073 parcels, 14 May – 19 Sep 2026): 877 delivered, 117 returned
(11.8%), forward charges PKR 209,009, return charges PKR 27,787, 95.4% of parcels carry the
Shopify order number, 54 parcels with zero COD (PR packages).

## Shopify facts

Admin GraphQL, version pinned in config (`2026-07`). Auth is the client credentials grant
(`POST /admin/oauth/access_token`, `grant_type=client_credentials`), 24h token, cached.
The token request REQUIRES `Accept: application/json` or Shopify returns HTML.
Scopes granted: read_orders, read_fulfillments, read_products, read_inventory,
read_locations, read_returns. Orders API returns the last 60 days by default.

## Read first

`docs/BUILD-PLAN.md` — the schema, the design decisions and why they are what they are.
Follow it. If you believe a decision in it is wrong, say so in the PR description and
implement it as written anyway.

## Definition of done

A task is done when ALL of these hold:

1. `npm run typecheck` passes with zero errors.
2. `npm run build` succeeds.
3. `npm test` passes, and the task's own new tests are among them.
4. The task's stated acceptance criteria each have a test or a command proving them.
5. Nothing outside the stated scope was modified. No dependency added unless the brief
   allows it. No reformatting of untouched files.
6. No secret, token, real customer name, real phone number or real address appears in any
   committed file, including fixtures and test snapshots.
7. New code matches the surrounding style: same comment density, same naming, same error
   handling shape. Comments explain why, not what.
8. The PR description states: what changed, which acceptance criteria are proven and how,
   any assumption made, and anything found-but-not-fixed.

If you cannot satisfy a criterion, STOP and say so plainly in the PR description. A partial
PR that is honest about the gap is worth more than a complete-looking one that is not.
