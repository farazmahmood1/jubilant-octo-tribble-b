-- Restocking no longer cancels a Shopify order. While the order is still open there, Shopify keeps
-- the returned units committed to it, and nothing can be added without counting them twice: that
-- attempt is `pending` until a person cancels the order (a separate, explicit action) or Shopify
-- settles it. The latest attempt is re-checked by shopify:catchup.
alter table shopify_writebacks drop constraint shopify_writebacks_outcome_check;
alter table shopify_writebacks add constraint shopify_writebacks_outcome_check check (outcome in ('done', 'skipped', 'failed', 'pending'));

-- When the background re-check last looked at a check-in whose answer had not changed (and so
-- wrote no attempt row). Scheduling only: it says nothing about where the return stands.
create table shopify_writeback_checks (
  check_in_id bigint primary key references return_check_ins (id) on delete restrict,
  checked_at  timestamptz not null
);
