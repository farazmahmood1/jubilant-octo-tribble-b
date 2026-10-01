import { type Db, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, ZERO, add, sub } from '../lib/money.js';
import { type Fragment, type ReportFilter, ledgerWhere } from './filter.js';

/**
 * The journal lines behind any report figure, one page at a time. Every report drills here: a
 * trial balance row is an account, a P&L cell is an account in a month, a partner ledger row is a
 * partner, an invoice, a bill or a payment is its source document. The filter names which, and the
 * server pages it, so a ledger of any size opens at once.
 *
 * With an account the lines are a general ledger: the balance brought forward before `from`, and a
 * running balance (debit less credit) on every line, correct on any page because each page starts
 * from the sum of the pages before it. Totals are over the whole filter, not the page, so the
 * figure a report shows and the lines behind it can be compared.
 */
export interface LinesFilter extends ReportFilter {
  /** Account code, e.g. `1100`. */
  account?: string;
  partnerType?: 'postex_account' | 'retail_partner' | 'vendor';
  partnerId?: string;
  /** The document that caused the lines (a reversal carries its original's source). */
  originType?: string;
  originId?: string;
  /** For a document whose entries share an id prefix, like a consignment import's sales. */
  originIdPrefix?: string;
  /** The lines of one PostEx payout (its payout lines' postings). */
  payoutId?: string;
  entryId?: string;
}

export interface JournalLineRow {
  lineId: string;
  entryId: string;
  date: string;
  memo: string;
  accountCode: string;
  accountName: string;
  debit: Paisa;
  credit: Paisa;
  originType: string;
  originId: string;
  shipmentId: string | null;
  isReversal: boolean;
  /** The entry has since been reversed by another. */
  reversed: boolean;
  /** Running balance after this line; null unless the page is one account's ledger. */
  balance: Paisa | null;
}

export interface LinesPage {
  total: number;
  page: number;
  pageSize: number;
  /** Sums over every line of the filter, not just this page. */
  debit: Paisa;
  credit: Paisa;
  /** Balance brought forward before `from`; null unless the filter names an account. */
  opening: Paisa | null;
  closing: Paisa | null;
  lines: JournalLineRow[];
}

const likeEscape = (text: string) => text.replace(/[\\%_]/g, '\\$&');

const where = (db: Db, f: LinesFilter): Fragment => db`
  ${ledgerWhere(db, f)}
  ${f.account ? db`and l.account_code = ${f.account}` : db``}
  ${f.partnerType ? db`and l.partner_type = ${f.partnerType}` : db``}
  ${f.partnerId ? db`and l.partner_id = ${f.partnerId}` : db``}
  ${f.originType ? db`and l.origin_type = ${f.originType}` : db``}
  ${f.originId ? db`and l.origin_id = ${f.originId}` : db``}
  ${f.originIdPrefix ? db`and l.origin_id like ${`${likeEscape(f.originIdPrefix)}%`}` : db``}
  ${f.payoutId ? db`and l.origin_type = 'payout_line' and l.origin_id in (select id::text from payout_lines where cod_payout_id = ${f.payoutId})` : db``}
  ${f.entryId ? db`and l.entry_id = ${f.entryId}` : db``}
`;

const order = (db: Db): Fragment => db`order by l.entry_date, l.entry_id, l.line_id`;

export const MAX_PAGE_SIZE = 200;

export const ledgerLinesPage = async (db: Db, f: LinesFilter, paging: { page: number; pageSize: number }): Promise<LinesPage> => {
  const pageSize = Math.min(Math.max(1, Math.floor(paging.pageSize)), MAX_PAGE_SIZE);
  const page = Math.max(1, Math.floor(paging.page));
  const offset = (page - 1) * pageSize;

  const [totals] = await db<{ n: number; debit: string; credit: string }[]>`
    select count(*)::int as n, coalesce(sum(l.debit_paisa), 0)::text as debit, coalesce(sum(l.credit_paisa), 0)::text as credit
    from ledger_lines l where true ${where(db, f)}
  `;

  // One account's ledger starts from what was brought forward, and each page from the pages before it.
  let opening: Paisa | null = null;
  let carried: Paisa = ZERO;
  if (f.account) {
    // Everything the filter would match, dated before the first day of the range.
    const [brought] = f.from
      ? await db<{ balance: string }[]>`
          select coalesce(sum(l.debit_paisa - l.credit_paisa), 0)::text as balance from ledger_lines l
          where l.entry_date < ${f.from}::date ${where(db, { ...f, from: undefined, to: undefined })}
        `
      : [{ balance: '0' }];
    opening = readPaisa(brought!.balance);
    carried = opening;
    if (offset > 0) {
      const [before] = await db<{ balance: string }[]>`
        select coalesce(sum(t.debit_paisa - t.credit_paisa), 0)::text as balance from (
          select l.debit_paisa, l.credit_paisa from ledger_lines l where true ${where(db, f)} ${order(db)} limit ${offset}
        ) t
      `;
      carried = add(opening, readPaisa(before!.balance));
    }
  }

  const rows = await db<
    {
      line_id: string; entry_id: string; date: string; memo: string; account_code: string; account_name: string; debit: string; credit: string;
      origin_type: string; origin_id: string; shipment_id: string | null; is_reversal: boolean; reversed: boolean;
    }[]
  >`
    select l.line_id::text, l.entry_id::text, l.entry_date::text as date, l.memo, l.account_code, l.account_name,
           l.debit_paisa::text as debit, l.credit_paisa::text as credit, l.origin_type, l.origin_id, l.shipment_id::text, l.is_reversal,
           e.reversed_by is not null as reversed
    from ledger_lines l join journal_entries e on e.id = l.entry_id
    where true ${where(db, f)} ${order(db)}
    limit ${pageSize} offset ${offset}
  `;

  let running = carried;
  const lines: JournalLineRow[] = rows.map((r) => {
    const debit = readPaisa(r.debit);
    const credit = readPaisa(r.credit);
    running = sub(add(running, debit), credit);
    return {
      lineId: r.line_id,
      entryId: r.entry_id,
      date: r.date,
      memo: r.memo,
      accountCode: r.account_code,
      accountName: r.account_name,
      debit,
      credit,
      originType: r.origin_type,
      originId: r.origin_id,
      shipmentId: r.shipment_id,
      isReversal: r.is_reversal,
      reversed: r.reversed,
      balance: f.account ? running : null,
    };
  });

  const debit = readPaisa(totals!.debit);
  const credit = readPaisa(totals!.credit);
  return {
    total: totals!.n,
    page,
    pageSize,
    debit,
    credit,
    opening,
    closing: opening === null ? null : sub(add(opening, debit), credit),
    lines,
  };
};

/** First and last Karachi day of a month given as `YYYY-MM`; null if it is not a real month. */
export const monthBounds = (month: string): { from: string; to: string } | null => {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { from: `${match[1]}-${match[2]}-01`, to: `${match[1]}-${match[2]}-${String(last).padStart(2, '0')}` };
};
