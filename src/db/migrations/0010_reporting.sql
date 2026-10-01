-- Step 14 reports read the ledger through one view, so every report resolves a journal line to
-- the same origin the same way. A reversal is its own entry pointing at the original
-- (reverses_id); here it carries the original's source, so "the sale of parcel 812" is the
-- sale and its reversal together and nets to zero. A payout line is traced to its parcel.
-- A view, not a table: nothing here is stored, so nothing can drift from the ledger (rule 7).
create view ledger_lines as
select
  l.id                                              as line_id,
  l.entry_id,
  e.entry_date,
  e.memo,
  a.code                                            as account_code,
  a.name                                            as account_name,
  a.type                                            as account_type,
  l.debit_paisa,
  l.credit_paisa,
  l.store_id,
  l.partner_type,
  l.partner_id,
  coalesce(o.source_type, e.source_type)            as origin_type,
  coalesce(o.source_id, e.source_id)                as origin_id,
  e.reverses_id is not null                         as is_reversal,
  case
    when coalesce(o.source_type, e.source_type) like 'shipment\_%' then coalesce(o.source_id, e.source_id)::bigint
    when coalesce(o.source_type, e.source_type) = 'payout_line'
      then (select pl.shipment_id from payout_lines pl where pl.id = coalesce(o.source_id, e.source_id)::bigint)
  end                                               as shipment_id
from journal_lines l
join journal_entries e on e.id = l.entry_id
join accounts a on a.id = l.account_id
left join journal_entries o on o.id = e.reverses_id;

-- Indexes the reports need that the ledger did not have (src/reports/index.ts lists, per
-- report, the indexes its plan must use; a test checks each one).
-- Every entry of a source, reversed or not: the partner breakdown finds a consignment sale's
-- partner through it. The existing unique index covers live entries only.
create index journal_entries_source_idx on journal_entries (source_type, source_id);
-- Return rate and delivery success are over parcels booked in a period.
create index shipments_booked_idx on shipments (booked_at);
