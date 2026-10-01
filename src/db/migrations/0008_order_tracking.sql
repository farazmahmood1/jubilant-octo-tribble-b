-- The PostEx tracking numbers written on a Shopify order by the team's "Book at PostEx" app
-- ("Order has been shipped via PostEx with Tracking 28544400000462"). The app writes them into
-- the order's note, not a fulfillment, so this is the one place an order names its own parcel.
-- Only the numbers are kept here; the note itself is free text that can hold an address, so it
-- stays only in orders.raw, which GDPR redaction masks.
alter table orders add column postex_tracking_numbers text[] not null default '{}';
create index orders_postex_tracking_idx on orders using gin (postex_tracking_numbers);

-- A parcel linked by the tracking number on its order: the strongest link there is.
alter table shipments drop constraint shipments_match_method_check;
alter table shipments add constraint shipments_match_method_check
  check (match_method in ('tracking_note', 'order_ref', 'cod_city_window', 'phone_window', 'manual'));
