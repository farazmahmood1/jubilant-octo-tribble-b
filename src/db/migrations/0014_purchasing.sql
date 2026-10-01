-- Batch F (BUILD-PLAN section 2): purchasing, the five steps of proposal 6.1: a request for stock,
-- vendors' quotations, the purchase order, the goods receipt and the vendor's bill, then payment.
--
-- Every row here is a document someone issued or received; none carries a hand-set status
-- (rule 7). How far a purchase order has got (received, billed, paid) is derived from its
-- receipts, bills and payments whenever it is read. Cancelling is an event, recorded with who
-- and when. Stock moves only through stock_moves and money only through journal_lines (rule 6):
-- a receipt writes both, a bill and a payment write the journal.

create table vendors (
  id                 bigint generated always as identity primary key,
  name               text not null check (length(trim(name)) > 0),
  -- The vendor's business contact. A supplier is a business, not a customer: 1.9 does not apply.
  contact_name       text,
  phone              text,
  email              text,
  city               text,
  -- Days from order to delivery, for reorder suggestions; the purchasing setting has a default.
  lead_time_days     integer check (lead_time_days between 0 and 365),
  payment_terms_days integer check (payment_terms_days between 0 and 365),
  notes              text,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index vendors_name_key on vendors (lower(trim(name)));

create trigger vendors_updated_at before update on vendors
  for each row execute function set_updated_at();

-- Step 1: someone asks for stock of one product. A request has one product, as Batch F lists it
-- without lines; asking for three products is three requests.
create table purchase_requests (
  id           bigint generated always as identity primary key,
  variant_id   bigint not null references variants (id) on delete restrict,
  qty          integer not null check (qty > 0),
  reason       text,
  requested_by bigint not null references users (id) on delete restrict,
  requested_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by bigint references users (id) on delete restrict,
  check ((cancelled_at is null) = (cancelled_by is null))
);

create index purchase_requests_variant_idx on purchase_requests (variant_id);

-- Step 2: a vendor's prices, to compare before ordering.
create table quotations (
  id          bigint generated always as identity primary key,
  vendor_id   bigint not null references vendors (id) on delete restrict,
  received_on date not null,
  valid_until date,
  reference   text,
  note        text,
  created_by  bigint not null references users (id) on delete restrict,
  created_at  timestamptz not null default now(),
  check (valid_until is null or valid_until >= received_on)
);

create table quotation_lines (
  id                  bigint generated always as identity primary key,
  quotation_id        bigint not null references quotations (id) on delete restrict,
  variant_id          bigint not null references variants (id) on delete restrict,
  -- The request it answers, if any.
  purchase_request_id bigint references purchase_requests (id) on delete restrict,
  qty                 integer not null check (qty > 0),
  unit_price_paisa    bigint not null check (unit_price_paisa >= 0)
);

create index quotation_lines_quotation_idx on quotation_lines (quotation_id);
create index quotation_lines_variant_idx on quotation_lines (variant_id);

-- Step 3: the order. One brand per order (store_id): every line is that brand's product, so the
-- stock, the cost and the money all land on one brand. A shared supplier gets one order per brand.
create table purchase_orders (
  id           bigint generated always as identity primary key,
  number       text not null unique generated always as ('PO-' || lpad(id::text, 5, '0')) stored,
  vendor_id    bigint not null references vendors (id) on delete restrict,
  store_id     bigint not null references stores (id) on delete restrict,
  quotation_id bigint references quotations (id) on delete restrict,
  ordered_on   date not null,
  expected_on  date,
  note         text,
  created_by   bigint not null references users (id) on delete restrict,
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by bigint references users (id) on delete restrict,
  check ((cancelled_at is null) = (cancelled_by is null)),
  check (expected_on is null or expected_on >= ordered_on)
);

create index purchase_orders_vendor_idx on purchase_orders (vendor_id);

create table po_lines (
  id                  bigint generated always as identity primary key,
  po_id               bigint not null references purchase_orders (id) on delete restrict,
  variant_id          bigint not null references variants (id) on delete restrict,
  purchase_request_id bigint references purchase_requests (id) on delete restrict,
  qty                 integer not null check (qty > 0),
  -- Agreed price per unit, before input tax: what a received unit costs.
  unit_cost_paisa     bigint not null check (unit_cost_paisa >= 0)
);

create index po_lines_po_idx on po_lines (po_id);
create index po_lines_variant_idx on po_lines (variant_id);
create index po_lines_request_idx on po_lines (purchase_request_id) where purchase_request_id is not null;

-- Step 4: goods arrive. A receipt can be partial; an order can have any number of them.
create table goods_receipts (
  id          bigint generated always as identity primary key,
  po_id       bigint not null references purchase_orders (id) on delete restrict,
  received_at timestamptz not null,
  received_by bigint not null references users (id) on delete restrict,
  note        text,
  created_at  timestamptz not null default now()
);

create index goods_receipts_po_idx on goods_receipts (po_id);

create table gr_lines (
  id         bigint generated always as identity primary key,
  receipt_id bigint not null references goods_receipts (id) on delete restrict,
  po_line_id bigint not null references po_lines (id) on delete restrict,
  qty        integer not null check (qty > 0),
  -- The cost this receipt wrote to product_costs for the product (moving average).
  product_cost_id bigint references product_costs (id) on delete restrict,
  unique (receipt_id, po_line_id)
);

create index gr_lines_po_line_idx on gr_lines (po_line_id);

-- Step 5: the vendor's bill, matched against the order and the receipts, then paid.
create table vendor_bills (
  id          bigint generated always as identity primary key,
  vendor_id   bigint not null references vendors (id) on delete restrict,
  po_id       bigint not null references purchase_orders (id) on delete restrict,
  -- The vendor's own invoice number: entering the same invoice twice is refused.
  bill_number text not null check (length(trim(bill_number)) > 0),
  bill_date   date not null,
  due_on      date,
  -- Input tax on the bill, claimable (it is the supplier's sales tax, not PostEx's).
  tax_paisa   bigint not null default 0 check (tax_paisa >= 0),
  created_by  bigint not null references users (id) on delete restrict,
  created_at  timestamptz not null default now(),
  check (due_on is null or due_on >= bill_date)
);

create unique index vendor_bills_number_key on vendor_bills (vendor_id, lower(trim(bill_number)));
create index vendor_bills_po_idx on vendor_bills (po_id);

-- A line is either goods on the order (po_line_id) or a charge with no product (freight, say).
create table bill_lines (
  id               bigint generated always as identity primary key,
  bill_id          bigint not null references vendor_bills (id) on delete restrict,
  po_line_id       bigint references po_lines (id) on delete restrict,
  description      text,
  qty              integer not null check (qty > 0),
  unit_price_paisa bigint not null check (unit_price_paisa >= 0),
  check (po_line_id is not null or length(trim(coalesce(description, ''))) > 0)
);

create index bill_lines_bill_idx on bill_lines (bill_id);
create index bill_lines_po_line_idx on bill_lines (po_line_id) where po_line_id is not null;

create table vendor_payments (
  id           bigint generated always as identity primary key,
  vendor_id    bigint not null references vendors (id) on delete restrict,
  bill_id      bigint not null references vendor_bills (id) on delete restrict,
  amount_paisa bigint not null check (amount_paisa > 0),
  paid_on      date not null,
  method       text not null check (method in ('bank_transfer', 'cash', 'cheque')),
  reference    text,
  created_by   bigint not null references users (id) on delete restrict,
  created_at   timestamptz not null default now()
);

create index vendor_payments_bill_idx on vendor_payments (bill_id);

-- Documents are corrected by new documents, never edited: a wrong receipt is answered by a
-- stock correction, a wrong bill by the vendor's credit note. Cancelling a request or an order
-- is the one change allowed, once.
create trigger quotations_append_only before update or delete on quotations for each row execute function forbid_change();
create trigger quotation_lines_append_only before update or delete on quotation_lines for each row execute function forbid_change();
create trigger po_lines_append_only before update or delete on po_lines for each row execute function forbid_change();
create trigger goods_receipts_append_only before update or delete on goods_receipts for each row execute function forbid_change();
create trigger gr_lines_append_only before update or delete on gr_lines for each row execute function forbid_change();
create trigger vendor_bills_append_only before update or delete on vendor_bills for each row execute function forbid_change();
create trigger bill_lines_append_only before update or delete on bill_lines for each row execute function forbid_change();
create trigger vendor_payments_append_only before update or delete on vendor_payments for each row execute function forbid_change();

create function cancel_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.cancelled_at is null and new.cancelled_at is not null
     -- A generated column (purchase_orders.number) is not filled in yet when this runs.
     and (to_jsonb(new) - 'cancelled_at' - 'cancelled_by' - 'number') = (to_jsonb(old) - 'cancelled_at' - 'cancelled_by' - 'number') then
    return new;
  end if;
  raise exception '% is append-only: it can only be cancelled, once', tg_table_name;
end;
$$;

create trigger purchase_requests_cancel_only before update or delete on purchase_requests for each row execute function cancel_only();
create trigger purchase_orders_cancel_only before update or delete on purchase_orders for each row execute function cancel_only();

-- Goods arrive before the bill does. Until it comes, what was received is owed but not yet
-- invoiced; the receipt puts its value in Inventory against this account, and the bill clears
-- it. A bill priced differently from the order (within tolerance) posts the difference to
-- purchase price variance, so Inventory always equals units received at the cost they were
-- received at.
insert into accounts (code, name, type) values
  ('2050', 'Goods received, not yet billed', 'liability'),
  ('5010', 'Purchase price variance', 'expense');
