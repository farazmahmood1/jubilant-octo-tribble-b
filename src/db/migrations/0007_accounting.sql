-- Batch G (BUILD-PLAN section 2): double-entry accounting. Applies 1.5, 1.6, 2.1 note 17 and
-- 3.2 notes S11–S14. Money balances only ever change through journal_lines (rule 6), and the
-- database itself refuses an entry that does not balance: the check runs at commit, over all of
-- an entry's lines, so no code path can leave one half-posted.

-- One chart for both brands. The brand is a dimension on each line (journal_lines.store_id),
-- so a P&L per brand is a filter, and a consolidated one is the same query without it.
create table accounts (
  id         bigint generated always as identity primary key,
  code       text not null unique check (code ~ '^[0-9]{4}$'),
  name       text not null,
  type       text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  parent_id  bigint references accounts (id) on delete restrict,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger accounts_updated_at before update on accounts
  for each row execute function set_updated_at();

insert into accounts (code, name, type) values
  ('1000', 'Bank', 'asset'),
  ('1100', 'COD receivable (PostEx)', 'asset'),
  ('1150', 'Customer receivable (prepaid and COD differences)', 'asset'),
  ('1200', 'Partner receivable', 'asset'),
  ('1300', 'Inventory', 'asset'),
  ('1400', 'Input tax', 'asset'),
  ('2000', 'Accounts payable', 'liability'),
  ('2100', 'Sales tax payable', 'liability'),
  ('3000', 'Owner''s equity', 'equity'),
  ('3100', 'Opening balances', 'equity'),
  ('4000', 'Sales revenue', 'income'),
  ('5000', 'Cost of goods sold', 'expense'),
  ('6000', 'Delivery expense (PostEx forward charges)', 'expense'),
  ('6010', 'Return expense (PostEx return charges)', 'expense'),
  ('6020', 'PostEx tax, not claimed', 'expense'),
  ('6100', 'Marketing expense (PR)', 'expense'),
  ('6200', 'Inventory write-off (damaged returns)', 'expense'),
  ('6900', 'General expenses', 'expense');

-- Rates in basis points (1600 = 16%): a rate is never a float either (rule 3).
create table tax_rates (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  rate_bp    integer not null check (rate_bp between 0 and 10000),
  account_id bigint not null references accounts (id) on delete restrict,
  created_at timestamptz not null default now()
);

insert into tax_rates (name, rate_bp, account_id)
select 'PostEx charges 16%', 1600, id from accounts where code = '1400';

-- A month in Karachi. Closed on or after the 5th of the next month (proposal 6.5 step 6), and
-- never reopened: a correction is a new entry dated in the next open period.
create table fiscal_periods (
  id         bigint generated always as identity primary key,
  year       integer not null check (year between 2000 and 2100),
  month      integer not null check (month between 1 and 12),
  status     text not null default 'open' check (status in ('open', 'closed')),
  closed_at  timestamptz,
  closed_by  bigint references users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (year, month),
  check ((status = 'closed') = (closed_at is not null))
);

create trigger fiscal_periods_updated_at before update on fiscal_periods
  for each row execute function set_updated_at();

create function forbid_reopen() returns trigger
language plpgsql as $$
begin
  if old.status = 'closed' and new.status <> 'closed' then
    raise exception 'Period %-% is closed and cannot be reopened; post the correction in the next open period',
      old.year, lpad(old.month::text, 2, '0');
  end if;
  return new;
end;
$$;

create trigger fiscal_periods_no_reopen before update on fiscal_periods
  for each row execute function forbid_reopen();

-- One posting. source_type/source_id say what caused it (1.10: every ledger row carries its
-- source), and only one live entry may exist per source (2.1 note 17). A reversal is its own
-- entry (source_type 'reversal', reverses_id set) and marks the original's reversed_by, which is
-- the one change an entry ever accepts.
create table journal_entries (
  id          bigint generated always as identity primary key,
  entry_date  date not null,
  memo        text not null,
  source_type text not null,
  source_id   text not null,
  posted_at   timestamptz not null default now(),
  -- Null for the system (sync jobs and replays).
  posted_by   bigint references users (id) on delete restrict,
  reverses_id bigint unique references journal_entries (id) on delete restrict,
  reversed_by bigint unique references journal_entries (id) on delete restrict,
  check ((source_type = 'reversal') = (reverses_id is not null))
);

create unique index journal_entries_live_source_key on journal_entries (source_type, source_id) where reversed_by is null;
create index journal_entries_date_idx on journal_entries (entry_date);

create function journal_entry_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'journal_entries is append-only: DELETE is not allowed; post a reversal';
  end if;
  if old.reversed_by is null and new.reversed_by is not null
     and (to_jsonb(new) - 'reversed_by') = (to_jsonb(old) - 'reversed_by') then
    return new;
  end if;
  raise exception 'journal_entries is append-only: an entry can only be marked reversed, once';
end;
$$;

create trigger journal_entries_append_only before update or delete on journal_entries
  for each row execute function journal_entry_guard();

-- Posting into a closed month fails here, whatever posts it.
create function journal_entry_open_period() returns trigger
language plpgsql as $$
declare
  closed fiscal_periods;
begin
  select * into closed from fiscal_periods
  where year = extract(year from new.entry_date) and month = extract(month from new.entry_date) and status = 'closed';
  if found then
    raise exception 'Period %-% is closed (since %): an entry dated % cannot be posted; date it in the next open period',
      closed.year, lpad(closed.month::text, 2, '0'), to_char(closed.closed_at at time zone 'Asia/Karachi', 'YYYY-MM-DD'), new.entry_date
      using errcode = 'P0001', hint = 'period_closed';
  end if;
  return new;
end;
$$;

create trigger journal_entries_open_period before insert on journal_entries
  for each row execute function journal_entry_open_period();

-- Each line is a debit or a credit, never both, never zero.
create table journal_lines (
  id           bigint generated always as identity primary key,
  entry_id     bigint not null references journal_entries (id) on delete restrict,
  account_id   bigint not null references accounts (id) on delete restrict,
  debit_paisa  bigint not null default 0 check (debit_paisa >= 0),
  credit_paisa bigint not null default 0 check (credit_paisa >= 0),
  partner_type text check (partner_type in ('postex_account', 'retail_partner', 'vendor')),
  partner_id   bigint,
  store_id     bigint references stores (id) on delete restrict,
  memo         text,
  check ((debit_paisa = 0) <> (credit_paisa = 0)),
  check ((partner_type is null) = (partner_id is null))
);

create index journal_lines_entry_idx on journal_lines (entry_id);
create index journal_lines_account_idx on journal_lines (account_id, store_id);
create index journal_lines_partner_idx on journal_lines (partner_type, partner_id) where partner_type is not null;

create trigger journal_lines_append_only before update or delete on journal_lines
  for each row execute function forbid_change();

-- Debits equal credits per entry, with at least two lines, checked at commit (deferred), after
-- every line of the entry is in.
create function journal_entry_balanced() returns trigger
language plpgsql as $$
declare
  -- Fired by an entry (its id) or by a line (its entry_id).
  entry bigint := coalesce(to_jsonb(new)->>'entry_id', to_jsonb(new)->>'id')::bigint;
  n integer;
  debits numeric;
  credits numeric;
begin
  select count(*), coalesce(sum(debit_paisa), 0), coalesce(sum(credit_paisa), 0) into n, debits, credits
  from journal_lines where entry_id = entry;
  if n < 2 or debits <> credits then
    raise exception 'Journal entry % does not balance: % lines, debits % paisa, credits % paisa', entry, n, debits, credits
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger journal_entries_balanced after insert on journal_entries
  deferrable initially deferred for each row execute function journal_entry_balanced();
create constraint trigger journal_lines_balanced after insert on journal_lines
  deferrable initially deferred for each row execute function journal_entry_balanced();

-- Set with any change that can move a parcel's postings (its status, its order link, PostEx's
-- charges, a check-in) in the same transaction, and cleared by the posting pass, as
-- stock_pending is for stock. A run that dies in between is caught up by the next.
alter table shipments add column accounting_pending boolean not null default true;
create index shipments_accounting_pending_idx on shipments (postex_account_id) where accounting_pending;

-- Sales invoices to retail partners and payments in or out (Steps 10 and 12). Schema only for
-- now: their postings are journal entries with source_type 'invoice' and 'payment'.
create table invoices (
  id          bigint generated always as identity primary key,
  partner_id  bigint not null references retail_partners (id) on delete restrict,
  store_id    bigint not null references stores (id) on delete restrict,
  number      text not null unique,
  issued_on   date not null,
  total_paisa bigint not null check (total_paisa >= 0),
  note        text,
  created_at  timestamptz not null default now()
);

create table invoice_lines (
  id               bigint generated always as identity primary key,
  invoice_id       bigint not null references invoices (id) on delete restrict,
  variant_id       bigint references variants (id) on delete restrict,
  description      text not null,
  qty              integer not null check (qty > 0),
  unit_price_paisa bigint not null check (unit_price_paisa >= 0),
  tax_paisa        bigint not null default 0 check (tax_paisa >= 0),
  total_paisa      bigint not null check (total_paisa >= 0)
);

create table payments (
  id           bigint generated always as identity primary key,
  direction    text not null check (direction in ('in', 'out')),
  partner_type text not null check (partner_type in ('postex_account', 'retail_partner', 'vendor')),
  partner_id   bigint not null,
  amount_paisa bigint not null check (amount_paisa > 0),
  paid_on      date not null,
  method       text not null check (method in ('bank', 'cash', 'cheque')),
  reference    text,
  actor_id     bigint references users (id) on delete restrict,
  created_at   timestamptz not null default now()
);

create table bank_statements (
  id           bigint generated always as identity primary key,
  account_id   bigint not null references accounts (id) on delete restrict,
  period_start date not null,
  period_end   date not null,
  file_name    text not null,
  imported_by  bigint references users (id) on delete restrict,
  imported_at  timestamptz not null default now(),
  check (period_end >= period_start)
);

create table bank_lines (
  id               bigint generated always as identity primary key,
  statement_id     bigint not null references bank_statements (id) on delete restrict,
  line_date        date not null,
  description      text not null,
  -- Signed: money in is positive.
  amount_paisa     bigint not null,
  reference        text,
  matched_entry_id bigint references journal_entries (id) on delete restrict
);
