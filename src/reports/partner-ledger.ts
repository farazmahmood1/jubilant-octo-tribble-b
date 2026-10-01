import { type Db, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, add, sub } from '../lib/money.js';
import { type ReportFilter, ledgerWhere, prefix } from './filter.js';

/**
 * Partner ledger: what each counterparty owes or is owed, from the lines that carry a partner:
 * each PostEx account (COD it holds), each retail partner (consignment sales unpaid) and each
 * vendor (bills unpaid). Balance is debit less credit: positive is owed to the business.
 */
export interface PartnerLedgerRow {
  partnerType: 'postex_account' | 'retail_partner' | 'vendor';
  partnerId: string;
  name: string;
  opening: Paisa;
  debit: Paisa;
  credit: Paisa;
  closing: Paisa;
}

const query = (db: Db, f: ReportFilter, explain = false) =>
  db<{ partner_type: PartnerLedgerRow['partnerType']; partner_id: string; name: string; opening: string; debit: string; credit: string }[]>`
    ${prefix(db, explain)}
    select l.partner_type, l.partner_id::text,
           coalesce(
             case l.partner_type
               when 'postex_account' then (select pa.label from postex_accounts pa where pa.id = l.partner_id)
               when 'retail_partner' then (select rp.name from retail_partners rp where rp.id = l.partner_id)
               when 'vendor' then (select v.name from vendors v where v.id = l.partner_id)
             end,
             l.partner_type || ' #' || l.partner_id
           ) as name,
           coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where ${f.from ? db`l.entry_date < ${f.from}::date` : db`false`}), 0)::text as opening,
           coalesce(sum(l.debit_paisa) filter (where ${f.from ? db`l.entry_date >= ${f.from}::date` : db`true`}), 0)::text as debit,
           coalesce(sum(l.credit_paisa) filter (where ${f.from ? db`l.entry_date >= ${f.from}::date` : db`true`}), 0)::text as credit
    from ledger_lines l
    where l.partner_type is not null ${ledgerWhere(db, { ...f, from: undefined })}
    group by l.partner_type, l.partner_id
    order by l.partner_type, l.partner_id
  `;

export const partnerLedger = async (db: Db, f: ReportFilter = {}): Promise<PartnerLedgerRow[]> =>
  (await query(db, f)).map((r) => {
    const opening = readPaisa(r.opening);
    const debit = readPaisa(r.debit);
    const credit = readPaisa(r.credit);
    return { partnerType: r.partner_type, partnerId: r.partner_id, name: r.name, opening, debit, credit, closing: sub(add(opening, debit), credit) };
  });

export const explainPartnerLedger = (db: Db, f: ReportFilter = {}) => query(db, f, true);

export const drillPartnerLedger = async (db: Db, f: ReportFilter, partner: { type: string; id: string }): Promise<{ entryIds: string[]; shipmentIds: string[] }> => {
  const rows = await db<{ entry_id: string; shipment_id: string | null }[]>`
    select l.entry_id, l.shipment_id::text from ledger_lines l
    where l.partner_type = ${partner.type} and l.partner_id = ${partner.id} ${ledgerWhere(db, f)}
    order by l.entry_id
  `;
  return { entryIds: [...new Set(rows.map((r) => r.entry_id))], shipmentIds: [...new Set(rows.flatMap((r) => (r.shipment_id ? [r.shipment_id] : [])))] };
};
