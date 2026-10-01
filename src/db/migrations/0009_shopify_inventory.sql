-- What Shopify says each variant has, per Shopify location, as of the last catalogue sync. A
-- source record like shipment_charges: it is read and compared, never a balance. Our stock
-- still only changes through stock_moves (rule 6); this is what an opening count can be taken
-- from, and what our warehouse is checked against.
--
-- Note the team does not mark orders fulfilled in Shopify (parcels go through PostEx), so
-- Shopify's on_hand still includes parcels that have left: `committed` holds them.
create table shopify_stock_levels (
  variant_id    bigint not null references variants (id) on delete restrict,
  store_id      bigint not null references stores (id) on delete restrict,
  location_gid  text not null,
  location_name text not null,
  on_hand       integer not null,
  available     integer not null,
  committed     integer not null,
  read_at       timestamptz not null,
  primary key (variant_id, location_gid)
);

create index shopify_stock_levels_store_idx on shopify_stock_levels (store_id);
