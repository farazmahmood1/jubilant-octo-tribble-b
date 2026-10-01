-- Batch B (BUILD-PLAN section 2): the catalogue of both stores, and what each variant costs.

-- Shopify product and variant ids are numeric; the gid prefix is stripped before storage. They
-- are only unique within a store, so every key below includes store_id.
create table products (
  id                 bigint generated always as identity primary key,
  store_id           bigint not null references stores (id) on delete restrict,
  shopify_product_id bigint not null,
  title              text not null,
  brand              text,
  -- Shopify's own status, lowercased (active, draft, archived, ...). Not constrained: a status
  -- Shopify adds later must not stop the catalogue syncing.
  status             text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (store_id, shopify_product_id),
  -- Target of the composite foreign key below, so a variant cannot point at another store's product.
  unique (id, store_id)
);

create trigger products_updated_at before update on products
  for each row execute function set_updated_at();

-- store_id is repeated here (2.1 note 2) so the uniques can include it, and the composite foreign
-- key keeps it equal to the product's.
create table variants (
  id                 bigint generated always as identity primary key,
  store_id           bigint not null,
  product_id         bigint not null,
  shopify_variant_id bigint not null,
  -- Juggun's Organics has no SKUs yet, so null is normal. An empty string is stored as null.
  sku                text check (sku <> ''),
  title              text not null,
  barcode            text check (barcode <> ''),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (store_id, shopify_variant_id),
  foreign key (product_id, store_id) references products (id, store_id) on delete restrict
);

create unique index variants_store_sku_key on variants (store_id, sku) where sku is not null;
create index variants_product_id_idx on variants (product_id);
-- The "unmapped variants" screen lists exactly these.
create index variants_missing_sku_idx on variants (store_id) where sku is null;

create trigger variants_updated_at before update on variants
  for each row execute function set_updated_at();

-- Effective-dated and append-only: a price change is a new row, never an edit, so profit for a
-- past order keeps using the cost in force when it was placed (proposal 6.1 step 4).
-- effective_from is a Karachi business date.
create table product_costs (
  id              bigint generated always as identity primary key,
  variant_id      bigint not null references variants (id) on delete restrict,
  unit_cost_paisa bigint not null check (unit_cost_paisa >= 0),
  effective_from  date not null,
  source          text not null check (source in ('import', 'goods_receipt', 'manual')),
  note            text,
  actor_id        bigint references users (id) on delete restrict,
  created_at      timestamptz not null default now()
);

-- Serves "the cost in force on date D": the newest effective_from on or before D, and the latest
-- entry when two share a date (a same-day correction).
create index product_costs_lookup_idx on product_costs (variant_id, effective_from desc, id desc);

create trigger product_costs_append_only before update or delete on product_costs
  for each row execute function forbid_change();
