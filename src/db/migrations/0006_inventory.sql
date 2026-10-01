-- Batch E (BUILD-PLAN section 2): the stock ledger. Applies 2.1 notes 15 and 16 and 3.2 notes
-- S8–S10. Stock is never a number that gets incremented (1.4): every movement is a stock_moves
-- row from one location to another, and stock_quants is only ever written by the trigger on
-- that table or rebuilt wholesale from it (rule 6).

-- Retail and grocery partners holding consignment stock. No location_id here (2.1 note 15): the
-- partner's location points at the partner, never both ways.
create table retail_partners (
  id         bigint generated always as identity primary key,
  name       text not null,
  contact    text,
  -- PII of a business contact; covered by the role serialisers like customer phones.
  phone      text check (phone ~ '^\+92[0-9]{9,10}$'),
  city       text,
  terms      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger retail_partners_updated_at before update on retail_partners
  for each row execute function set_updated_at();

-- Where a unit can be (1.4). The system locations have a key the code finds them by; partner
-- locations have none, one per partner.
create table locations (
  id         bigint generated always as identity primary key,
  key        text unique check (key ~ '^[a-z][a-z0-9_]*$'),
  kind       text not null check (kind in ('warehouse', 'partner', 'in_transit', 'returning', 'customer',
                                           'marketing', 'damaged', 'supplier', 'adjustment')),
  label      text not null,
  partner_id bigint unique references retail_partners (id) on delete restrict,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'partner') = (partner_id is not null)),
  check (kind = 'partner' or key is not null)
);

create trigger locations_updated_at before update on locations
  for each row execute function set_updated_at();

insert into locations (key, kind, label) values
  ('warehouse', 'warehouse', 'Main warehouse'),
  ('in_transit', 'in_transit', 'With PostEx, outcome unknown'),
  ('returning', 'returning', 'Returning: PostEx return started or done, not yet checked in'),
  ('customer', 'customer', 'Sold and delivered'),
  ('marketing', 'marketing', 'PR packages delivered'),
  ('damaged', 'damaged', 'Returned unfit'),
  ('supplier', 'supplier', 'Suppliers'),
  ('adjustment', 'adjustment', 'Counts and corrections');

-- A stock count or correction. Its lines are the stock_moves that reference it.
create table stock_adjustments (
  id          bigint generated always as identity primary key,
  location_id bigint not null references locations (id) on delete restrict,
  reason      text not null check (reason in ('opening_stock', 'count', 'correction', 'damage', 'loss')),
  note        text,
  actor_id    bigint references users (id) on delete restrict,
  at          timestamptz not null default now()
);

create trigger stock_adjustments_append_only before update or delete on stock_adjustments
  for each row execute function forbid_change();

-- A person checking a returned parcel in at the warehouse. PostEx's 0006 says the parcel is back
-- at the merchant; only this row says someone has it in hand (step 8, 3.2 note S8). The gap
-- between the two is the returns-not-checked-in alert. One per parcel, and never edited.
create table return_check_ins (
  id            bigint generated always as identity primary key,
  shipment_id   bigint not null unique references shipments (id) on delete restrict,
  outcome       text not null check (outcome in ('restocked', 'damaged')),
  note          text,
  actor_id      bigint not null references users (id) on delete restrict,
  checked_in_at timestamptz not null default now()
);

create trigger return_check_ins_append_only before update or delete on return_check_ins
  for each row execute function forbid_change();

-- The ledger (1.4). Append-only and keyed so a rerun inserts nothing it already has (2.1 note
-- 16). ref_type/ref_id name the business event that caused the move. shipment_id is set on every
-- move a parcel makes, so the parcel's position is the net of its own moves.
create table stock_moves (
  id               bigint generated always as identity primary key,
  variant_id       bigint not null references variants (id) on delete restrict,
  qty              integer not null check (qty > 0),
  from_location_id bigint not null references locations (id) on delete restrict,
  to_location_id   bigint not null references locations (id) on delete restrict,
  reason           text not null,
  ref_type         text not null,
  ref_id           text not null,
  shipment_id      bigint references shipments (id) on delete restrict,
  actor_id         bigint references users (id) on delete restrict,
  occurred_at      timestamptz not null,
  note             text,
  created_at       timestamptz not null default now(),
  unique (ref_type, ref_id, variant_id, from_location_id, to_location_id),
  check (from_location_id <> to_location_id)
);

create index stock_moves_shipment_idx on stock_moves (shipment_id) where shipment_id is not null;
create index stock_moves_variant_idx on stock_moves (variant_id, occurred_at);

create trigger stock_moves_append_only before update or delete on stock_moves
  for each row execute function forbid_change();

-- Set in the same transaction as any change to a parcel's derived status or its order link, and
-- cleared by the stock pass once the parcel's moves match it. A run that dies in between leaves it
-- set, so the next run catches up; nothing depends on remembering what changed in memory.
alter table shipments add column stock_pending boolean not null default true;
create index shipments_stock_pending_idx on shipments (postex_account_id) where stock_pending and order_id is not null;

-- Current stock per (variant, location), materialised for speed and rebuildable from scratch.
-- Negative is allowed and expected until the opening count is loaded (section 4).
create table stock_quants (
  variant_id  bigint not null references variants (id) on delete restrict,
  location_id bigint not null references locations (id) on delete restrict,
  qty         bigint not null,
  primary key (variant_id, location_id)
);

create function apply_stock_move() returns trigger
language plpgsql as $$
begin
  insert into stock_quants (variant_id, location_id, qty) values
    (new.variant_id, new.from_location_id, -new.qty),
    (new.variant_id, new.to_location_id, new.qty)
  on conflict (variant_id, location_id) do update set qty = stock_quants.qty + excluded.qty;
  return null;
end;
$$;

create trigger stock_moves_apply after insert on stock_moves
  for each row execute function apply_stock_move();

create table consignment_transfers (
  id         bigint generated always as identity primary key,
  partner_id bigint not null references retail_partners (id) on delete restrict,
  sent_at    timestamptz,
  status     text not null default 'draft' check (status in ('draft', 'sent', 'cancelled')),
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'sent') = (sent_at is not null))
);

create trigger consignment_transfers_updated_at before update on consignment_transfers
  for each row execute function set_updated_at();

create table partner_sales_imports (
  id           bigint generated always as identity primary key,
  partner_id   bigint not null references retail_partners (id) on delete restrict,
  period_start date not null,
  period_end   date not null,
  file_name    text not null,
  status       text not null default 'pending' check (status in ('pending', 'imported', 'failed', 'reverted')),
  rows_ok      integer not null default 0 check (rows_ok >= 0),
  rows_failed  integer not null default 0 check (rows_failed >= 0),
  imported_by  bigint references users (id) on delete restrict,
  at           timestamptz not null default now(),
  check (period_end >= period_start)
);
