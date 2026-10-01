-- Batch H, influencer half: who the influencers are and which discount codes are theirs, so the
-- influencer breakdown (Step 14) attributes an order to a person, not to a raw code. PR sends
-- and posts (pr_sends, influencer_posts) land with Step 13.

create table influencers (
  id         bigint generated always as identity primary key,
  -- The Instagram or TikTok handle, without the @. Unique however it is capitalised.
  handle     text not null check (handle ~ '^[A-Za-z0-9._]{1,60}$'),
  name       text not null check (length(trim(name)) > 0),
  city       text,
  followers  integer check (followers >= 0),
  niche      text,
  notes      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index influencers_handle_key on influencers (lower(handle));

create trigger influencers_updated_at before update on influencers
  for each row execute function set_updated_at();

-- A code belongs to one influencer per store; codes are matched however they were typed at
-- checkout, so uniqueness ignores case.
create table influencer_codes (
  id            bigint generated always as identity primary key,
  influencer_id bigint not null references influencers (id) on delete restrict,
  store_id      bigint not null references stores (id) on delete restrict,
  discount_code text not null check (discount_code = trim(discount_code) and length(discount_code) between 1 and 60),
  created_at    timestamptz not null default now()
);

create unique index influencer_codes_store_code_key on influencer_codes (store_id, lower(discount_code));
create index influencer_codes_influencer_idx on influencer_codes (influencer_id);
