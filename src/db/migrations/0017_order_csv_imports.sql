-- Step 16: order history older than the Shopify API's 60-day window, from each store's order
-- export CSV. The orders land in `orders` with source = 'csv_import' (3.2 note S19), keyed on the
-- same (store_id, shopify_order_id) as API rows, so an order in both is one row: the API's, which
-- an import never overwrites and the API sync always does. Each committed run is recorded here;
-- running the same file again changes no order (rule 5) and records the run.
create table order_csv_imports (
  id                 bigint generated always as identity primary key,
  store_id           bigint not null references stores (id) on delete restrict,
  file_name          text not null,
  file_sha256        text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  rows_total         integer not null check (rows_total >= 0),
  orders_inserted    integer not null check (orders_inserted >= 0),
  orders_updated     integer not null check (orders_updated >= 0),
  orders_unchanged   integer not null check (orders_unchanged >= 0),
  -- Already in the database from the API, which wins.
  orders_api_kept    integer not null check (orders_api_kept >= 0),
  orders_malformed   integer not null check (orders_malformed >= 0),
  parcels_matched    integer not null check (parcels_matched >= 0),
  imported_by        bigint not null references users (id) on delete restrict,
  imported_at        timestamptz not null default now()
);

create index order_csv_imports_store_idx on order_csv_imports (store_id, imported_at desc);

create trigger order_csv_imports_append_only before update or delete on order_csv_imports
  for each row execute function forbid_change();
