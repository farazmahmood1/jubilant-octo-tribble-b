-- Batch C (BUILD-PLAN section 2): customers, their addresses, orders and their lines, and the
-- webhook log. Applies 2.1 notes 3–7: composite keys, _paisa on every money column, and a
-- derived order state with its log.

-- Only what delivery needs (1.9): name, phone, address. No email.
-- external_key is the idempotency key: 'shopify:<customer id>' for a Shopify customer,
-- 'phone:<+92…>' for a guest with a phone, 'order:<order id>' for a guest with neither, so a
-- re-sync never creates a second row for the same person.
create table customers (
  id                  bigint generated always as identity primary key,
  store_id            bigint not null references stores (id) on delete restrict,
  external_key        text not null check (external_key ~ '^(shopify|phone|order):.+$'),
  shopify_customer_id bigint,
  name                text,
  phone_e164          text check (phone_e164 ~ '^\+923[0-9]{9}$'),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (store_id, external_key),
  unique (id, store_id)
);

create unique index customers_store_shopify_key on customers (store_id, shopify_customer_id)
  where shopify_customer_id is not null;
-- Refusal history is looked up by phone across both stores (1.9).
create index customers_phone_idx on customers (phone_e164) where phone_e164 is not null;

create trigger customers_updated_at before update on customers
  for each row execute function set_updated_at();

-- One row per distinct address per customer. fingerprint is a hash of the normalised fields,
-- so the same address on many orders is stored once.
create table addresses (
  id          bigint generated always as identity primary key,
  customer_id bigint not null references customers (id) on delete restrict,
  fingerprint text not null,
  line1       text,
  line2       text,
  city        text,
  province    text,
  postal      text,
  country     text,
  created_at  timestamptz not null default now(),
  unique (customer_id, fingerprint)
);

create table orders (
  id                  bigint generated always as identity primary key,
  store_id            bigint not null references stores (id) on delete restrict,
  -- Null only for consignment sales, which never existed in Shopify.
  shopify_order_id    bigint,
  -- Shopify's order name, e.g. '#1234'. What PostEx parcels carry as orderRefNumber.
  order_number        text not null,
  placed_at           timestamptz not null,
  customer_id         bigint,
  shipping_address_id bigint references addresses (id) on delete restrict,
  financial_status    text,
  fulfillment_status  text,
  currency            char(3) not null default 'PKR' check (currency = 'PKR'),
  subtotal_paisa      bigint not null check (subtotal_paisa >= 0),
  discount_paisa      bigint not null default 0 check (discount_paisa >= 0),
  shipping_paisa      bigint not null default 0 check (shipping_paisa >= 0),
  tax_paisa           bigint not null default 0 check (tax_paisa >= 0),
  total_paisa         bigint not null check (total_paisa >= 0),
  channel             text not null check (channel in ('online', 'consignment', 'pr')),
  cancelled_at        timestamptz,
  cancel_reason       text,
  tags                text[] not null default '{}',
  discount_codes      text[] not null default '{}',
  -- Where the row came from (3.2 note S19). A CSV import and the API share the key, so an
  -- overlapping import merges into the API row instead of duplicating it.
  source              text not null default 'api' check (source in ('api', 'csv_import', 'consignment')),
  -- Written only by the order state recompute (1.10), never by a sync or a route.
  state               text check (state in ('placed', 'confirmed', 'ready_to_book', 'booked', 'in_transit', 'delivered',
                                            'failed', 'returning', 'returned_received', 'cancelled', 'pr')),
  raw                 jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (store_id, shopify_order_id),
  unique (store_id, order_number),
  foreign key (customer_id, store_id) references customers (id, store_id) on delete restrict,
  check ((shopify_order_id is null) = (source = 'consignment')),
  check (source <> 'consignment' or channel = 'consignment')
);

create index orders_placed_idx on orders (store_id, placed_at desc);
create index orders_customer_idx on orders (customer_id);
create index orders_state_idx on orders (store_id, state) where state is not null;
-- Influencer attribution looks orders up by discount code.
create index orders_discount_codes_idx on orders using gin (discount_codes);

create trigger orders_updated_at before update on orders
  for each row execute function set_updated_at();

-- line_key keeps lines idempotent: 'shopify:<line item id>' for Shopify lines, 'line:<n>' for
-- consignment imports. Lines are replaced with the order on every sync.
create table order_lines (
  id               bigint generated always as identity primary key,
  order_id         bigint not null references orders (id) on delete restrict,
  line_key         text not null check (line_key ~ '^(shopify|line):.+$'),
  variant_id       bigint references variants (id) on delete restrict,
  sku              text,
  title            text not null,
  -- Zero after an order edit removes the item; Shopify keeps the line.
  qty              integer not null check (qty >= 0),
  unit_price_paisa bigint not null check (unit_price_paisa >= 0),
  discount_paisa   bigint not null default 0 check (discount_paisa >= 0),
  total_paisa      bigint not null check (total_paisa >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (order_id, line_key)
);

create index order_lines_variant_idx on order_lines (variant_id);

create trigger order_lines_updated_at before update on order_lines
  for each row execute function set_updated_at();

-- Every state change, with the event that caused it (Step 7: "log every transition").
create table order_state_log (
  id         bigint generated always as identity primary key,
  order_id   bigint not null references orders (id) on delete restrict,
  from_state text,
  to_state   text not null,
  cause      text not null,
  at         timestamptz not null default now()
);

create index order_state_log_order_idx on order_state_log (order_id, at desc);

create trigger order_state_log_append_only before update or delete on order_state_log
  for each row execute function forbid_change();

-- Webhook deliveries, deduplicated on Shopify's event id (1.7, 2.1 note 4).
create table webhook_events (
  id               bigint generated always as identity primary key,
  store_id         bigint not null references stores (id) on delete restrict,
  topic            text not null,
  shopify_event_id text not null,
  received_at      timestamptz not null default now(),
  processed_at     timestamptz,
  payload          jsonb not null,
  unique (store_id, shopify_event_id)
);

-- The catch-up job retries whatever was received but never processed.
create index webhook_events_unprocessed_idx on webhook_events (store_id, received_at) where processed_at is null;
