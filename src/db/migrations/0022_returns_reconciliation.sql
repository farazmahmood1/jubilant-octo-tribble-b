-- Returns as each source records them, so the platform can tell them apart and reconcile them:
-- a parcel's stage from its whole PostEx history, a check-in split by product, and the refunds
-- and returns recorded in Shopify.

-- A parcel's stage, from the same replay of its history as the order's state (order-state.ts
-- `parcelStage`), written with status_code by refreshDerived (rule 7: derived on every change).
-- status_code is only the latest step, and PostEx keeps sending movement codes after a return has
-- started (0039, 0037, 0035, 0032 on the way back), so a test on status_code alone misses most
-- parcels that are coming back. Null only until the next sync, or `npm run migrate`, re-derives
-- a parcel stored before this column existed.
alter table shipments
  add column stage text check (stage in ('booked', 'in_transit', 'attempted', 'delivered', 'returning', 'returned', 'cancelled'));

create index shipments_stage_idx on shipments (postex_account_id, stage);

-- A check-in can split a parcel's units: some back on the shelf, some damaged. `mixed` check-ins
-- say how many of each product went where; a restocked or damaged one sends every unit one way.
-- Append-only like the check-in itself.
alter table return_check_ins drop constraint return_check_ins_outcome_check;
alter table return_check_ins add constraint return_check_ins_outcome_check check (outcome in ('restocked', 'damaged', 'mixed'));

create table return_check_in_lines (
  check_in_id bigint not null references return_check_ins (id) on delete restrict,
  variant_id  bigint not null references variants (id) on delete restrict,
  restocked   integer not null check (restocked >= 0),
  damaged     integer not null check (damaged >= 0),
  check (restocked + damaged > 0),
  primary key (check_in_id, variant_id)
);

create trigger return_check_in_lines_append_only before update or delete on return_check_in_lines
  for each row execute function forbid_change();

-- Shopify's own record of money and goods coming back, read with the order on every sync. A
-- cancellation is a refund too (of nothing, for a COD order): its lines say whether Shopify put
-- the units back (restock_type CANCEL, restocked true) or not (NO_RESTOCK). None of this is a
-- PostEx return, and a PostEx return is none of this until someone records it in Shopify.
alter table orders
  add column refunded_paisa bigint not null default 0 check (refunded_paisa >= 0),
  -- Shopify's Order.returnStatus: NO_RETURN, RETURN_REQUESTED, IN_PROGRESS, RETURNED, ...
  add column return_status text;

create table shopify_refunds (
  id                bigint generated always as identity primary key,
  store_id          bigint not null references stores (id) on delete restrict,
  order_id          bigint not null references orders (id) on delete restrict,
  shopify_refund_id bigint not null,
  refunded_at       timestamptz not null,
  amount_paisa      bigint not null check (amount_paisa >= 0),
  unique (store_id, shopify_refund_id)
);

create index shopify_refunds_order_idx on shopify_refunds (order_id);

create table shopify_refund_lines (
  refund_id            bigint not null references shopify_refunds (id) on delete restrict,
  shopify_line_item_id bigint not null,
  qty                  integer not null check (qty >= 0),
  -- RefundLineItemRestockType: CANCEL, RETURN, NO_RESTOCK, LEGACY_RESTOCK.
  restock_type         text not null,
  restocked            boolean not null,
  amount_paisa         bigint not null default 0,
  primary key (refund_id, shopify_line_item_id)
);

create table shopify_returns (
  id                bigint generated always as identity primary key,
  store_id          bigint not null references stores (id) on delete restrict,
  order_id          bigint not null references orders (id) on delete restrict,
  shopify_return_id bigint not null,
  name              text,
  -- ReturnStatus: REQUESTED, OPEN, CLOSED, CANCELED, DECLINED.
  status            text not null,
  opened_at         timestamptz,
  closed_at         timestamptz,
  -- [{"lineItemId": "…", "qty": 1, "reason": "…"}] as Shopify lists them.
  lines             jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  unique (store_id, shopify_return_id)
);

create index shopify_returns_order_idx on shopify_returns (order_id);
