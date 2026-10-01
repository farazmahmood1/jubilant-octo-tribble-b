-- Batch H, PR half (Step 13): PR packages stop looking like missing stock and lost sales.
--
-- A PR send is a parcel, an order, or goods handed over with neither, that went to an influencer
-- as marketing. Detection finds likely ones made outside the platform (an order tagged PR, an
-- order discounted to zero, a PostEx parcel with zero COD) and SUGGESTS them: CLAUDE.md and note
-- S16 say each zero-COD parcel is classified by a person (PR, replacement or gift), never assumed
-- to be PR. Only a person's classification, or the team's own PR tag in Shopify, makes a send PR.
-- Detection inserts and never updates, so it never overrides what a person decided.

create table pr_sends (
  id             bigint generated always as identity primary key,
  influencer_id  bigint references influencers (id) on delete restrict,
  shipment_id    bigint unique references shipments (id) on delete restrict,
  order_id       bigint unique references orders (id) on delete restrict,
  source         text not null check (source in ('auto', 'manual')),
  -- Why detection suggested it; null for a send a person entered.
  detected_by    text check (detected_by in ('shopify_pr_tag', 'full_discount', 'zero_cod')),
  -- Null while it is only a suggestion. `not_pr` is a person saying detection was wrong.
  classification text check (classification in ('pr', 'replacement', 'gift', 'not_pr')),
  decided_by     bigint references users (id) on delete restrict,
  decided_at     timestamptz,
  sent_at        timestamptz not null,
  note           text,
  created_by     bigint references users (id) on delete restrict,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((source = 'auto') = (detected_by is not null)),
  check ((decided_by is null) = (decided_at is null)),
  -- A decision is a person's, except the PR tag, which the team set in Shopify themselves.
  check ((classification is null) = (decided_by is null) or (detected_by = 'shopify_pr_tag' and classification = 'pr' and decided_by is null)),
  check (source = 'manual' or shipment_id is not null or order_id is not null)
);

create index pr_sends_influencer_idx on pr_sends (influencer_id) where influencer_id is not null;
create index pr_sends_pending_idx on pr_sends (created_at) where classification is null;

create trigger pr_sends_updated_at before update on pr_sends
  for each row execute function set_updated_at();

-- What went in a send that has no order lines to say so (a parcel booked outside Shopify, or
-- goods handed over). Entered once, by a person.
create table pr_send_lines (
  id         bigint generated always as identity primary key,
  pr_send_id bigint not null references pr_sends (id) on delete restrict,
  variant_id bigint not null references variants (id) on delete restrict,
  qty        integer not null check (qty > 0),
  unique (pr_send_id, variant_id)
);

create trigger pr_send_lines_append_only before update or delete on pr_send_lines for each row execute function forbid_change();

create table influencer_posts (
  id            bigint generated always as identity primary key,
  influencer_id bigint not null references influencers (id) on delete restrict,
  pr_send_id    bigint references pr_sends (id) on delete restrict,
  url           text not null check (url ~ '^https?://'),
  kind          text not null check (kind in ('reel', 'story', 'post')),
  posted_at     timestamptz not null,
  note          text,
  created_by    bigint not null references users (id) on delete restrict,
  created_at    timestamptz not null default now(),
  unique (influencer_id, url)
);

create index influencer_posts_send_idx on influencer_posts (pr_send_id) where pr_send_id is not null;

-- The one definition of "this parcel is PR", for stock, accounting and every report: its order
-- is a PR order (the Shopify tag), or a person classified the parcel or its order as PR.
create function shipment_is_pr(p_shipment bigint) returns boolean
language sql stable as $$
  select exists (
    select 1 from shipments s left join orders o on o.id = s.order_id
    where s.id = p_shipment
      and (o.channel = 'pr'
           or exists (select 1 from pr_sends ps where ps.classification = 'pr' and ps.shipment_id = s.id)
           or exists (select 1 from pr_sends ps where ps.classification = 'pr' and s.order_id is not null and ps.order_id = s.order_id))
  )
$$;

create function order_is_pr(p_order bigint) returns boolean
language sql stable as $$
  select exists (select 1 from orders o where o.id = p_order and o.channel = 'pr')
      or exists (select 1 from pr_sends ps where ps.classification = 'pr' and ps.order_id = p_order)
      or exists (select 1 from pr_sends ps join shipments s on s.id = ps.shipment_id where ps.classification = 'pr' and s.order_id = p_order)
$$;
