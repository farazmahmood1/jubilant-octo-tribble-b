-- A person unlinked a parcel from an order because it was the wrong one. The matcher retries every
-- unmatched parcel on each sync, so without a record it would pick the same wrong order again.
-- These are the orders a person has ruled out for this parcel; matching never offers them. A
-- manual link is a person's choice and is not held to the list. Order ids as text, as elsewhere in
-- JSON and detail columns.
alter table shipments add column ruled_out_order_ids text[] not null default '{}';
