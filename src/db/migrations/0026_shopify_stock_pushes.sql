-- Stock changes made in the platform, carried to Shopify's available stock: adjustments and counts,
-- goods received, consignment transfers and PR sends handed over outside Shopify. Parcels and
-- returns are not here: Shopify moves those itself through the order (and the returns write-back).
-- One row per pushed stock move, keyed on the move, so a move reaches Shopify at most once; a failed
-- attempt is retried by shopify:stock-push and its row brought up to date. Scheduling state about
-- one move, never a balance (rule 6 is about stock_moves themselves, which stay append-only).
create table shopify_stock_pushes (
  stock_move_id bigint primary key references stock_moves (id) on delete restrict,
  store_id      bigint not null references stores (id) on delete restrict,
  outcome       text not null check (outcome in ('done', 'skipped', 'failed')),
  -- What Shopify's available stock was (or would have been) changed by: + into the warehouse, - out.
  delta         integer not null check (delta <> 0),
  message       text not null,
  attempts      integer not null default 1 check (attempts > 0),
  first_at      timestamptz not null default now(),
  last_at       timestamptz not null default now()
);

create index shopify_stock_pushes_failed_idx on shopify_stock_pushes (last_at) where outcome = 'failed';

-- Everything recorded before pushing existed stays as it is in Shopify: replaying it now would
-- count it a second time wherever Shopify was already corrected by hand.
insert into shopify_stock_pushes (stock_move_id, store_id, outcome, delta, message)
select m.id, v.store_id, 'skipped', case when m.to_location_id = w.id then m.qty else -m.qty end,
       'Recorded before stock changes were pushed to Shopify'
from stock_moves m
join variants v on v.id = m.variant_id
cross join (select id from locations where key = 'warehouse') w
where m.ref_type in ('stock_adjustment', 'gr_line', 'consignment_transfer_line', 'pr_send_line')
  and w.id in (m.from_location_id, m.to_location_id);
