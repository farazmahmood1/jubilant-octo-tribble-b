-- Two additions: a returned parcel's check-in carried through to Shopify, and the business's own
-- expenses (ads, salaries, rent, packaging), which the P&L needs to show net profit (proposal 6.5).

-- Each attempt to bring Shopify in line with a return check-in, as it happened. Append-only, like
-- the audit log: where a check-in stands in Shopify is its latest row, derived on read (rule 7),
-- and a retry is a new row. `steps` in detail lists what Shopify accepted, so a retry after a
-- partial failure does only what is left.
--
--   outcome  done     Shopify now agrees with the check-in
--            skipped  nothing to do, and why (the order was already cancelled in Shopify, the
--                     parcel has no Shopify order, write-back is switched off)
--            failed   Shopify refused or could not be reached; the error says which
create table shopify_writebacks (
  id          bigint generated always as identity primary key,
  check_in_id bigint not null references return_check_ins (id) on delete restrict,
  store_id    bigint references stores (id) on delete restrict,
  outcome     text not null check (outcome in ('done', 'skipped', 'failed')),
  -- What was asked of Shopify: cancel_restock (an open order cancelled with its items restocked),
  -- restock (units added back to available), write_off (units removed as damaged), none.
  action      text not null,
  detail      jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  error       text,
  actor_id    bigint references users (id) on delete restrict,
  at          timestamptz not null default now()
);

create index shopify_writebacks_check_in_idx on shopify_writebacks (check_in_id, at desc, id desc);

create trigger shopify_writebacks_append_only before update or delete on shopify_writebacks
  for each row execute function forbid_change();

-- Money paid out that is not a vendor bill for stock: advertising, salaries, rent, packaging,
-- utilities and the rest. Each one posts one journal entry (expense / bank or cash); a mistake
-- is voided, which reverses that entry. Never edited (rule 6).
create table expenses (
  id           bigint generated always as identity primary key,
  spent_on     date not null,
  category     text not null check (category in ('advertising', 'salaries', 'rent', 'packaging', 'utilities', 'other')),
  -- The brand it was for; null when it served both, which shows in the combined P&L only.
  store_id     bigint references stores (id) on delete restrict,
  amount_paisa bigint not null check (amount_paisa > 0),
  paid_from    text not null check (paid_from in ('bank', 'cash')),
  payee        text,
  note         text,
  created_by   bigint not null references users (id) on delete restrict,
  created_at   timestamptz not null default now(),
  voided_at    timestamptz,
  voided_by    bigint references users (id) on delete restrict,
  void_reason  text,
  check ((voided_at is null) = (voided_by is null))
);

create index expenses_spent_on_idx on expenses (spent_on);

insert into accounts (code, name, type) values
  ('1010', 'Cash in hand', 'asset'),
  ('6300', 'Advertising', 'expense'),
  ('6310', 'Salaries and wages', 'expense'),
  ('6320', 'Rent', 'expense'),
  ('6330', 'Packaging', 'expense'),
  ('6340', 'Utilities', 'expense');
