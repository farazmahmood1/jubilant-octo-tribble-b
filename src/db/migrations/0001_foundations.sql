-- Batch A (BUILD-PLAN section 2): the tables every later batch hangs off.

-- Keeps updated_at honest without every query remembering to set it. Only a real change moves
-- it, so an idempotent upsert that rewrites identical values leaves the row untouched.
create function set_updated_at() returns trigger
language plpgsql as $$
begin
  if new is distinct from old then
    new.updated_at = now();
  end if;
  return new;
end;
$$;

-- Ledger-style tables are corrected by new rows, never by editing old ones.
create function forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op;
end;
$$;

-- One row per Shopify store. The key is what config, URLs and account_ref use.
create table stores (
  id          bigint generated always as identity primary key,
  key         text not null unique check (key in ('nur', 'organics')),
  label       text not null,
  shop_domain text not null unique check (shop_domain like '%.myshopify.com'),
  currency    char(3) not null default 'PKR' check (currency = 'PKR'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger stores_updated_at before update on stores
  for each row execute function set_updated_at();

-- One row per PostEx merchant account. store_id is the default link used when matching
-- parcels to orders; nullable so an account can be registered before its store is known.
create table postex_accounts (
  id         bigint generated always as identity primary key,
  key        text not null unique check (key ~ '^[a-z][a-z0-9_]*$'),
  label      text not null,
  store_id   bigint references stores (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index postex_accounts_store_id_idx on postex_accounts (store_id);

create trigger postex_accounts_updated_at before update on postex_accounts
  for each row execute function set_updated_at();

-- Emails are stored lowercased so uniqueness cannot be dodged by case. password_hash stays
-- null until real accounts replace the env sign-in.
create table users (
  id            bigint generated always as identity primary key,
  email         text not null unique check (email = lower(email) and email like '%_@_%'),
  name          text not null,
  role          text not null check (role in ('owner', 'manager', 'operations', 'agent', 'accountant')),
  password_hash text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger users_updated_at before update on users
  for each row execute function set_updated_at();

-- Who changed what. actor_id is null for the system (sync jobs, migrations). entity_id is text
-- because entities are keyed by bigint ids, Shopify gids and PostEx tracking numbers alike.
create table audit_log (
  id        bigint generated always as identity primary key,
  actor_id  bigint references users (id) on delete restrict,
  action    text not null,
  entity    text not null,
  entity_id text,
  before    jsonb,
  after     jsonb,
  at        timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log (entity, entity_id, at desc);
create index audit_log_actor_idx on audit_log (actor_id, at desc);
create index audit_log_at_idx on audit_log (at desc);

create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function forbid_change();

-- Editable thresholds and templates (alert days, WhatsApp wording), read by key.
create table app_settings (
  key        text primary key,
  value      jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger app_settings_updated_at before update on app_settings
  for each row execute function set_updated_at();

-- One row per worker job run. account_ref is the store or PostEx account key the run covered.
create table sync_runs (
  id          bigint generated always as identity primary key,
  job         text not null,
  account_ref text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  stats       jsonb not null default '{}',
  error       text,
  check (finished_at is null or finished_at >= started_at),
  check ((status = 'running') = (finished_at is null))
);

create index sync_runs_job_idx on sync_runs (job, account_ref, started_at desc);
-- "Is anything still running / did the last run fail" is asked on every dashboard load.
create index sync_runs_unfinished_idx on sync_runs (job, account_ref) where status <> 'succeeded';

-- Where each job resumes. The cursor is opaque to the database: a timestamp, a page token or
-- a date, depending on the job.
create table integration_cursors (
  job         text not null,
  account_ref text not null,
  cursor      text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (job, account_ref)
);

create trigger integration_cursors_updated_at before update on integration_cursors
  for each row execute function set_updated_at();
