-- Batch D (BUILD-PLAN section 2): PostEx parcels, their history and charges, and COD payouts.
-- Applies 2.1 notes 9–14. reconciliation_items already exists (0004); it gains its foreign key
-- to shipments here.

-- One row per parcel per PostEx account (2.1 note 10, rule 9). The parcel's status, attempt
-- count and last failure reason are derived from shipment_events after every change, never set
-- from a single payload: a list row carries no history and must not erase what the detail call
-- found (rule 7).
create table shipments (
  id                  bigint generated always as identity primary key,
  postex_account_id   bigint not null references postex_accounts (id) on delete restrict,
  tracking_number     text not null,
  order_ref_number    text,
  order_id            bigint references orders (id) on delete restrict,
  match_confidence    numeric(3, 2) check (match_confidence between 0 and 1),
  match_method        text check (match_method in ('order_ref', 'cod_city_window', 'phone_window', 'manual')),
  status_code         text,
  status_message      text,
  -- PostEx's own label ("Out For Delivery"). Labels differ between endpoints, so it is never
  -- matched on for state, only for the refresh cadence.
  status_label        text,
  booked_at           timestamptz,
  delivered_at        timestamptz,
  status_updated_at   timestamptz,
  cod_amount_paisa    bigint check (cod_amount_paisa >= 0),
  city                text,
  -- Normalised +92… (2.1 note 9). PII: covered by the accountant serialiser and by redaction.
  customer_phone      text check (customer_phone ~ '^\+923[0-9]{9}$'),
  items               integer,
  attempts_count      integer not null default 0 check (attempts_count >= 0),
  last_failure_reason text,
  -- Mapper flags (unknown_status, invalid_date, ...), kept so they can be queried.
  flags               text[] not null default '{}',
  raw                 jsonb,
  last_synced_at      timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (postex_account_id, tracking_number),
  check ((order_id is null) = (match_method is null))
);

create index shipments_order_idx on shipments (order_id) where order_id is not null;
create index shipments_unmatched_idx on shipments (postex_account_id) where order_id is null;
create index shipments_refresh_idx on shipments (postex_account_id, last_synced_at);
create index shipments_status_idx on shipments (postex_account_id, status_code);

create trigger shipments_updated_at before update on shipments
  for each row execute function set_updated_at();

-- Append-only and uniquely keyed, so re-polling a parcel inserts nothing it already has. NULLS
-- NOT DISTINCT: a step with no readable time must still dedupe against itself.
create table shipment_events (
  id          bigint generated always as identity primary key,
  shipment_id bigint not null references shipments (id) on delete restrict,
  code        text not null,
  message     text not null,
  occurred_at timestamptz,
  raw         jsonb,
  created_at  timestamptz not null default now(),
  unique nulls not distinct (shipment_id, code, occurred_at)
);

create trigger shipment_events_append_only before update or delete on shipment_events
  for each row execute function forbid_change();

-- What PostEx charged on a parcel, upserted per kind: PostEx corrects fees late (2.1 note 10).
create table shipment_charges (
  id           bigint generated always as identity primary key,
  shipment_id  bigint not null references shipments (id) on delete restrict,
  kind         text not null check (kind in ('forward', 'forward_tax', 'reversal', 'reversal_tax')),
  amount_paisa bigint not null check (amount_paisa > 0),
  booked_at    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (shipment_id, kind)
);

create trigger shipment_charges_updated_at before update on shipment_charges
  for each row execute function set_updated_at();

-- One row per payment receipt (CPR) per account, with the parcels it paid (2.1 notes 10–11).
create table cod_payouts (
  id                bigint generated always as identity primary key,
  postex_account_id bigint not null references postex_accounts (id) on delete restrict,
  cpr_number        text not null,
  paid_at           timestamptz,
  amount_paisa      bigint not null default 0,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (postex_account_id, cpr_number)
);

create trigger cod_payouts_updated_at before update on cod_payouts
  for each row execute function set_updated_at();

create table payout_lines (
  id            bigint generated always as identity primary key,
  cod_payout_id bigint not null references cod_payouts (id) on delete restrict,
  shipment_id   bigint not null references shipments (id) on delete restrict,
  amount_paisa  bigint not null,
  created_at    timestamptz not null default now(),
  unique (cod_payout_id, shipment_id)
);

alter table reconciliation_items
  add constraint reconciliation_items_shipment_id_fkey foreign key (shipment_id) references shipments (id) on delete restrict;
