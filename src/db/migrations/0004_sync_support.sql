-- What the Shopify syncs and webhooks need beyond Batches B and C: a review queue for what they
-- cannot store, soft deletion for catalogue rows Shopify no longer has, and GDPR redaction.

-- The reconciliation queue from Batch D, created early because the order sync already has items
-- for it. shipment_id has no foreign key yet: shipments arrive with Batch D, which adds it.
-- dedupe_key stops the same problem being queued twice while it is still open.
create table reconciliation_items (
  id          bigint generated always as identity primary key,
  kind        text not null,
  severity    text not null default 'warning' check (severity in ('info', 'warning', 'error')),
  dedupe_key  text not null,
  store_id    bigint references stores (id) on delete restrict,
  shipment_id bigint,
  order_id    bigint references orders (id) on delete restrict,
  detail      jsonb not null default '{}',
  status      text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  resolved_by bigint references users (id) on delete restrict,
  resolved_at timestamptz,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check ((status = 'open') = (resolved_at is null))
);

create unique index reconciliation_items_open_key on reconciliation_items (dedupe_key) where status = 'open';
create index reconciliation_items_queue_idx on reconciliation_items (status, kind, created_at);

create trigger reconciliation_items_updated_at before update on reconciliation_items
  for each row execute function set_updated_at();

-- A product or variant gone from Shopify cannot be deleted here: order lines and, later, stock
-- moves refer to it. It is marked instead, and unmarked if it comes back.
alter table products add column deleted_at timestamptz;
alter table variants add column deleted_at timestamptz;

drop index variants_missing_sku_idx;
create index variants_missing_sku_idx on variants (store_id) where sku is null and deleted_at is null;

-- After a GDPR redaction the customer's phone can no longer be its key, so the row is re-keyed
-- 'redacted:<id>'. The row itself stays: orders and their history still refer to it.
alter table customers drop constraint customers_external_key_check;
alter table customers add constraint customers_external_key_check
  check (external_key ~ '^(shopify|phone|order|redacted):.+$');
alter table customers add column redacted_at timestamptz;
