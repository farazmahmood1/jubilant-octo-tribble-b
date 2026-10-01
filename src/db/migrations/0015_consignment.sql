-- Consignment (Step 12): stock at a retail partner is still ours until the partner sells it.
-- Transfers move it warehouse → partner (or back); the partner's sales sheet, imported, moves
-- what sold partner → customer, raises the invoice and posts the sale and its cost.
--
-- 0006 created consignment_transfers and partner_sales_imports with hand-set status columns
-- (draft/sent, pending/imported/reverted), which rule 7 does not allow, and nothing ever wrote to
-- them. They are replaced by tables whose state is what happened to them; this refuses to run
-- if either table holds a row, so nothing is lost silently.
do $$
begin
  if exists (select 1 from consignment_transfers) or exists (select 1 from partner_sales_imports) then
    raise exception 'consignment_transfers or partner_sales_imports has rows; migrate them by hand before 0015';
  end if;
end;
$$;

drop table consignment_transfers;
drop table partner_sales_imports;

alter table retail_partners add column is_active boolean not null default true;

-- One transfer is one trip: goods out to a partner, or back from one.
create table consignment_transfers (
  id         bigint generated always as identity primary key,
  partner_id bigint not null references retail_partners (id) on delete restrict,
  direction  text not null check (direction in ('out', 'back')),
  sent_at    timestamptz not null,
  note       text,
  created_by bigint not null references users (id) on delete restrict,
  created_at timestamptz not null default now()
);

create index consignment_transfers_partner_idx on consignment_transfers (partner_id, sent_at desc);

create table consignment_transfer_lines (
  id          bigint generated always as identity primary key,
  transfer_id bigint not null references consignment_transfers (id) on delete restrict,
  variant_id  bigint not null references variants (id) on delete restrict,
  qty         integer not null check (qty > 0),
  unique (transfer_id, variant_id)
);

-- One committed partner sales sheet. The file's SHA-256 identifies it: the same file again is
-- refused, unless the person says it is a new version (a corrected sheet with the same rows is
-- a different file). Reversing is the one change allowed, once, as a unit.
create table partner_sales_imports (
  id            bigint generated always as identity primary key,
  partner_id    bigint not null references retail_partners (id) on delete restrict,
  file_name     text not null,
  file_sha256   text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  version       integer not null default 1 check (version >= 1),
  rows_total    integer not null check (rows_total >= 0),
  rows_imported integer not null check (rows_imported >= 0),
  -- Committed with invalid rows skipped, because the person forced it.
  forced        boolean not null default false,
  imported_by   bigint not null references users (id) on delete restrict,
  imported_at   timestamptz not null default now(),
  reversed_at   timestamptz,
  reversed_by   bigint references users (id) on delete restrict,
  reversal_reason text,
  unique (partner_id, file_sha256, version),
  check ((reversed_at is null) = (reversed_by is null)),
  check (reversed_at is null or reversal_reason is not null),
  check (rows_imported <= rows_total)
);

-- One sold line of a sheet: the sale.
create table partner_sales (
  id               bigint generated always as identity primary key,
  import_id        bigint not null references partner_sales_imports (id) on delete restrict,
  row_number       integer not null check (row_number >= 2),
  sale_date        date not null,
  variant_id       bigint not null references variants (id) on delete restrict,
  store_id         bigint not null references stores (id) on delete restrict,
  qty              integer not null check (qty > 0),
  unit_price_paisa bigint not null check (unit_price_paisa >= 0),
  tax_paisa        bigint not null default 0 check (tax_paisa >= 0),
  unit_cost_paisa  bigint not null check (unit_cost_paisa >= 0),
  unique (import_id, row_number)
);

create index partner_sales_import_idx on partner_sales (import_id);

-- The invoice an import raises, one per brand on it.
alter table invoices
  add column import_id bigint references partner_sales_imports (id) on delete restrict,
  add column voided_at timestamptz;

create index invoices_import_idx on invoices (import_id) where import_id is not null;

create trigger consignment_transfers_append_only before update or delete on consignment_transfers for each row execute function forbid_change();
create trigger consignment_transfer_lines_append_only before update or delete on consignment_transfer_lines for each row execute function forbid_change();
create trigger partner_sales_append_only before update or delete on partner_sales for each row execute function forbid_change();

create function import_reverse_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.reversed_at is null and new.reversed_at is not null
     and (to_jsonb(new) - 'reversed_at' - 'reversed_by' - 'reversal_reason') = (to_jsonb(old) - 'reversed_at' - 'reversed_by' - 'reversal_reason') then
    return new;
  end if;
  raise exception 'partner_sales_imports is append-only: an import can only be reversed, once';
end;
$$;

create trigger partner_sales_imports_reverse_only before update or delete on partner_sales_imports
  for each row execute function import_reverse_only();
