import type { Sql } from '../db.js';
import { openReviewItem } from '../db/repos/review.js';
import { type Db, atomically, big, readPaisa } from '../db/repos/upsert.js';
import { costAt } from '../db/repos/variants.js';
import { POSTEX_STATUS_CODES, type ShipmentEvent } from '../integrations/postex/mapper.js';
import { type Paisa, ZERO, add, paisa, sub, sum } from '../lib/money.js';
import { endOfKarachiDay, formatKarachi } from '../lib/time.js';
import { canonicalOrder, deliveryEpisodes, parcelTimeline } from './order-state.js';

/**
 * Double-entry postings (BUILD-PLAN 1.5, Step 10). Every financial event becomes one journal
 * entry whose lines balance; the database refuses one that does not (0007). Entries are never
 * edited: a correction is a reversal, then a new entry.
 *
 * | Event                          | Debit                                       | Credit                          |
 * |--------------------------------|---------------------------------------------|---------------------------------|
 * | Delivered sale                 | COD receivable (+ customer receivable for a prepaid part) | Sales revenue, Sales tax payable |
 * | COGS on delivery               | Cost of goods sold (Marketing for PR, S10)  | Inventory                       |
 * | PostEx forward charge + tax    | Delivery expense, PostEx tax (or Input tax) | COD receivable                  |
 * | PostEx return charge + tax     | Return expense, PostEx tax (or Input tax)   | COD receivable                  |
 * | COD payout received            | Bank                                        | COD receivable                  |
 * | Returned after delivery        | reverse the sale and the COGS; both charges stay                |
 * | Refused, never delivered (S11) | nothing to reverse: only the charges post                       |
 * | Damaged on check-in (S12)      | Inventory write-off                         | Inventory                       |
 * | PR parcel charges (S12)        | Marketing expense                           | COD receivable                  |
 * | Vendor bill                    | Inventory / General expenses, Input tax     | Accounts payable                |
 * | Vendor payment                 | Accounts payable                            | Bank                            |
 * | Consignment sale               | Partner receivable                          | Sales revenue, Sales tax payable |
 * | Consignment COGS (S12)         | Cost of goods sold                          | Inventory                       |
 * | Partner payment (S12)          | Bank                                        | Partner receivable              |
 *
 * PostEx's 16% tax on its charges is expensed, not claimed, until the accountant decides (S13);
 * the `accounting` setting `claimPostexInputTax: true` sends it to Input tax instead.
 */

export const ACCOUNT_CODES = {
  bank: '1000',
  codReceivable: '1100',
  customerReceivable: '1150',
  partnerReceivable: '1200',
  inventory: '1300',
  inputTax: '1400',
  payable: '2000',
  goodsReceivedNotBilled: '2050',
  salesTaxPayable: '2100',
  equity: '3000',
  openingBalances: '3100',
  revenue: '4000',
  cogs: '5000',
  priceVariance: '5010',
  deliveryExpense: '6000',
  returnExpense: '6010',
  postexTax: '6020',
  marketing: '6100',
  writeOff: '6200',
  general: '6900',
} as const;

export type AccountKey = keyof typeof ACCOUNT_CODES;

export interface Partner {
  type: 'postex_account' | 'retail_partner' | 'vendor';
  id: string;
}

export interface Line {
  account: AccountKey;
  debit?: Paisa;
  credit?: Paisa;
  storeId?: string | null;
  partner?: Partner | null;
}

export interface Source {
  type: string;
  id: string;
}

export class AccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountingError';
  }
}

export class PeriodClosedError extends AccountingError {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodClosedError';
  }
}

const dr = (account: AccountKey, amount: Paisa, extra: Omit<Line, 'account'> = {}): Line => ({ account, debit: amount, ...extra });
const cr = (account: AccountKey, amount: Paisa, extra: Omit<Line, 'account'> = {}): Line => ({ account, credit: amount, ...extra });

/**
 * Drops zero lines and turns a negative amount into the opposite side, so a builder can write
 * "receivable minus charges" without branching. The result is what gets posted.
 */
export const normalise = (lines: readonly Line[]): Line[] =>
  lines.flatMap((line): Line[] => {
    const net = sub(line.debit ?? ZERO, line.credit ?? ZERO);
    if (net === 0n) return [];
    const { debit: _d, credit: _c, ...rest } = line;
    return [net > 0n ? { ...rest, debit: net } : { ...rest, credit: paisa(-net) }];
  });

export const isBalanced = (lines: readonly Line[]): boolean =>
  sum(lines.map((l) => l.debit ?? ZERO)) === sum(lines.map((l) => l.credit ?? ZERO));

/** The Karachi calendar day of an instant: entries are dated in business days (rule 4). */
export const karachiDay = (at: Date): string => formatKarachi(at).slice(0, 10);

// ---- Line builders, one per event. Pure: amounts in, lines out. ----

export interface SaleInput {
  storeId: string;
  postexAccountId: string;
  /** What PostEx collects. */
  codAmount: Paisa;
  orderTotal: Paisa;
  /** Shopify's tax lines as recorded (S13 default). */
  orderTax: Paisa;
}

/** Revenue is the order net of tax; whatever the courier does not collect is owed by the customer (prepaid). */
export const saleLines = (s: SaleInput): Line[] =>
  normalise([
    dr('codReceivable', s.codAmount, { storeId: s.storeId, partner: { type: 'postex_account', id: s.postexAccountId } }),
    dr('customerReceivable', sub(s.orderTotal, s.codAmount), { storeId: s.storeId }),
    cr('revenue', sub(s.orderTotal, s.orderTax), { storeId: s.storeId }),
    cr('salesTaxPayable', s.orderTax, { storeId: s.storeId }),
  ]);

/** Goods leave inventory as cost of sales, or as marketing for a PR parcel (S10). */
export const cogsLines = (c: { storeId: string; cost: Paisa; pr: boolean }): Line[] =>
  normalise([dr(c.pr ? 'marketing' : 'cogs', c.cost, { storeId: c.storeId }), cr('inventory', c.cost, { storeId: c.storeId })]);

export interface ChargeInput {
  storeId: string;
  postexAccountId: string;
  fee: Paisa;
  tax: Paisa;
  pr: boolean;
  claimTax: boolean;
}

const chargeLines = (expense: AccountKey, c: ChargeInput): Line[] =>
  normalise([
    dr(c.pr ? 'marketing' : expense, c.fee, { storeId: c.storeId }),
    dr(c.claimTax ? 'inputTax' : c.pr ? 'marketing' : 'postexTax', c.tax, { storeId: c.storeId }),
    cr('codReceivable', add(c.fee, c.tax), { storeId: c.storeId, partner: { type: 'postex_account', id: c.postexAccountId } }),
  ]);

/** PostEx deducts its forward charge from the COD it holds. */
export const forwardChargeLines = (c: ChargeInput): Line[] => chargeLines('deliveryExpense', c);
/** The return charge is deducted the same way; a negative receivable is money owed to PostEx. */
export const returnChargeLines = (c: ChargeInput): Line[] => chargeLines('returnExpense', c);

export const payoutLines = (p: { storeId: string; postexAccountId: string; amount: Paisa }): Line[] =>
  normalise([
    dr('bank', p.amount, { storeId: p.storeId }),
    cr('codReceivable', p.amount, { storeId: p.storeId, partner: { type: 'postex_account', id: p.postexAccountId } }),
  ]);

export const writeOffLines = (w: { storeId: string; cost: Paisa }): Line[] =>
  normalise([dr('writeOff', w.cost, { storeId: w.storeId }), cr('inventory', w.cost, { storeId: w.storeId })]);

export interface VendorBillInput {
  vendorId: string;
  storeId?: string | null;
  inventory: Paisa;
  expense: Paisa;
  tax: Paisa;
}

/** Input tax on a supplier bill is claimable (it is the supplier's sales tax, not PostEx's). */
export const vendorBillLines = (b: VendorBillInput): Line[] =>
  normalise([
    dr('inventory', b.inventory, { storeId: b.storeId ?? null }),
    dr('general', b.expense, { storeId: b.storeId ?? null }),
    dr('inputTax', b.tax, { storeId: b.storeId ?? null }),
    cr('payable', add(add(b.inventory, b.expense), b.tax), { storeId: b.storeId ?? null, partner: { type: 'vendor', id: b.vendorId } }),
  ]);

export const vendorPaymentLines = (p: { vendorId: string; amount: Paisa; storeId?: string | null }): Line[] =>
  normalise([
    dr('payable', p.amount, { storeId: p.storeId ?? null, partner: { type: 'vendor', id: p.vendorId } }),
    cr('bank', p.amount, { storeId: p.storeId ?? null }),
  ]);

/** Goods received ahead of the bill: in Inventory at the order's price, owed but not yet invoiced. */
export const goodsReceiptLines = (r: { vendorId: string; storeId: string; value: Paisa }): Line[] =>
  normalise([
    dr('inventory', r.value, { storeId: r.storeId }),
    cr('goodsReceivedNotBilled', r.value, { storeId: r.storeId, partner: { type: 'vendor', id: r.vendorId } }),
  ]);

export interface PurchaseBillInput {
  vendorId: string;
  storeId: string;
  /** Billed units at the order's price: what the receipts put in Inventory, now invoiced. */
  received: Paisa;
  /** Billed price minus the order's price, on those units; negative when the bill is cheaper. */
  variance: Paisa;
  /** Lines with no product (freight, say). */
  charges: Paisa;
  tax: Paisa;
}

/**
 * A bill against a purchase order clears what its receipts left owed but not billed. A price
 * different from the order's goes to purchase price variance, so Inventory stays at what the
 * receipts valued it at (the cost the products carry).
 */
export const purchaseBillLines = (b: PurchaseBillInput): Line[] => {
  const extra = { storeId: b.storeId };
  const vendor = { ...extra, partner: { type: 'vendor' as const, id: b.vendorId } };
  return normalise([
    dr('goodsReceivedNotBilled', b.received, vendor),
    dr('priceVariance', b.variance, extra),
    dr('general', b.charges, extra),
    dr('inputTax', b.tax, extra),
    cr('payable', add(add(add(b.received, b.variance), b.charges), b.tax), vendor),
  ]);
};

export interface ConsignmentSaleInput {
  partnerId: string;
  storeId: string;
  net: Paisa;
  tax: Paisa;
  cost: Paisa;
}

export const consignmentSaleLines = (c: ConsignmentSaleInput): Line[] =>
  normalise([
    dr('partnerReceivable', add(c.net, c.tax), { storeId: c.storeId, partner: { type: 'retail_partner', id: c.partnerId } }),
    cr('revenue', c.net, { storeId: c.storeId }),
    cr('salesTaxPayable', c.tax, { storeId: c.storeId }),
  ]);

export const partnerPaymentLines = (p: { partnerId: string; storeId?: string | null; amount: Paisa }): Line[] =>
  normalise([
    dr('bank', p.amount, { storeId: p.storeId ?? null }),
    cr('partnerReceivable', p.amount, { storeId: p.storeId ?? null, partner: { type: 'retail_partner', id: p.partnerId } }),
  ]);

// ---- Posting ----

const accountIds = new WeakMap<object, Map<string, string>>();

const accountId = async (db: Db, key: AccountKey): Promise<string> => {
  let ids = accountIds.get(db);
  if (!ids) {
    const rows = await db<{ id: string; code: string }[]>`select id, code from accounts`;
    ids = new Map(rows.map((r) => [r.code, r.id]));
    accountIds.set(db, ids);
  }
  const id = ids.get(ACCOUNT_CODES[key]);
  if (!id) throw new AccountingError(`Account ${ACCOUNT_CODES[key]} (${key}) is not in the chart`);
  return id;
};

/** The first day of the next month that is not closed, on or after `day`. */
export const firstOpenDay = async (db: Db, day: string): Promise<string> => {
  let [year, month] = day.split('-').map(Number) as [number, number];
  let candidate = day;
  for (;;) {
    const [closed] = await db`select 1 from fiscal_periods where year = ${year} and month = ${month} and status = 'closed'`;
    if (!closed) return candidate;
    month = month === 12 ? 1 : month + 1;
    if (month === 1) year++;
    candidate = `${year}-${String(month).padStart(2, '0')}-01`;
  }
};

export interface PostInput {
  date: string;
  memo: string;
  source: Source;
  lines: readonly Line[];
  postedBy?: string | null;
  /**
   * When the date's month is closed, date the entry on the first day of the next open month
   * instead of failing (BUILD-PLAN Batch G: corrections post in the next open period). Syncs
   * use it; a person posting by hand does not, and gets the closed-period error.
   */
  rollForward?: boolean;
  /** Which delivery of a parcel the entry belongs to (0011); 1 for everything else. */
  occurrence?: number;
}

export interface Posted {
  id: string;
  created: boolean;
  date: string;
}

const periodError = (error: unknown): never => {
  if (error instanceof Error && 'hint' in error && (error as { hint?: string }).hint === 'period_closed') throw new PeriodClosedError(error.message);
  throw error;
};

/**
 * Posts one entry, or returns the live entry already posted for the same source: posting the
 * same event twice is a no-op. Null when every line is zero (nothing happened in money).
 */
export const postEntry = async (db: Db, input: PostInput): Promise<Posted | null> => {
  const lines = normalise(input.lines);
  if (lines.length === 0) return null;
  if (!isBalanced(lines)) throw new AccountingError(`Entry for ${input.source.type} ${input.source.id} does not balance`);
  return atomically(db, async (tx) => {
    const [live] = await tx<{ id: string; entry_date: string }[]>`
      select id, entry_date::text from journal_entries
      where source_type = ${input.source.type} and source_id = ${input.source.id} and reversed_by is null
    `;
    if (live) return { id: live.id, created: false, date: live.entry_date };
    const date = input.rollForward ? await firstOpenDay(tx, input.date) : input.date;
    const memo = date === input.date ? input.memo : `${input.memo} (event dated ${input.date}, period closed)`;
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (entry_date, memo, source_type, source_id, posted_by, occurrence)
      values (${date}, ${memo}, ${input.source.type}, ${input.source.id}, ${input.postedBy ?? null}, ${input.occurrence ?? 1})
      returning id
    `.catch(periodError);
    for (const line of lines) {
      await tx`
        insert into journal_lines (entry_id, account_id, debit_paisa, credit_paisa, partner_type, partner_id, store_id)
        values (${entry!.id}, ${await accountId(tx, line.account)}, ${big(line.debit ?? ZERO)}, ${big(line.credit ?? ZERO)},
                ${line.partner?.type ?? null}, ${line.partner?.id ?? null}, ${line.storeId ?? null})
      `;
    }
    return { id: entry!.id, created: true, date };
  });
};

/** Reverses an entry: the same lines with debit and credit swapped, linked both ways. */
export const reverseEntry = async (
  db: Db,
  entryId: string,
  input: { date: string; memo: string; postedBy?: string | null; rollForward?: boolean },
): Promise<string> =>
  atomically(db, async (tx) => {
    const [original] = await tx<{ reversed_by: string | null; memo: string }[]>`
      select reversed_by, memo from journal_entries where id = ${entryId} for update
    `;
    if (!original) throw new AccountingError(`Journal entry ${entryId} not found`);
    if (original.reversed_by) throw new AccountingError(`Journal entry ${entryId} is already reversed`);
    const date = input.rollForward ? await firstOpenDay(tx, input.date) : input.date;
    const [reversal] = await tx<{ id: string }[]>`
      insert into journal_entries (entry_date, memo, source_type, source_id, posted_by, reverses_id)
      values (${date}, ${`${input.memo}: reverses "${original.memo}"`}, 'reversal', ${entryId}, ${input.postedBy ?? null}, ${entryId})
      returning id
    `.catch(periodError);
    await tx`
      insert into journal_lines (entry_id, account_id, debit_paisa, credit_paisa, partner_type, partner_id, store_id)
      select ${reversal!.id}, account_id, credit_paisa, debit_paisa, partner_type, partner_id, store_id
      from journal_lines where entry_id = ${entryId} order by id
    `;
    await tx`update journal_entries set reversed_by = ${reversal!.id} where id = ${entryId}`;
    return reversal!.id;
  });

/** The live entry for a source, with its lines in the builder's shape, for comparison. */
const liveEntry = async (db: Db, source: Source): Promise<{ id: string; date: string; lines: Line[] } | null> => {
  const [entry] = await db<{ id: string; entry_date: string }[]>`
    select id, entry_date::text from journal_entries where source_type = ${source.type} and source_id = ${source.id} and reversed_by is null
  `;
  return entry ? { id: entry.id, date: entry.entry_date, lines: await entryLines(db, entry.id) } : null;
};

/** An entry's lines in the builder's shape. */
const entryLines = async (db: Db, entryId: string): Promise<Line[]> => {
  const rows = await db<{ code: string; debit: string; credit: string; partner_type: Partner['type'] | null; partner_id: string | null; store_id: string | null }[]>`
    select a.code, l.debit_paisa::text as debit, l.credit_paisa::text as credit, l.partner_type, l.partner_id, l.store_id
    from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = ${entryId} order by l.id
  `;
  const byCode = new Map<string, AccountKey>(Object.entries(ACCOUNT_CODES).map(([k, code]) => [code, k as AccountKey]));
  return rows.map((r) => {
    const debit = readPaisa(r.debit);
    const credit = readPaisa(r.credit);
    return {
      account: byCode.get(r.code) ?? ('general' as AccountKey),
      ...(debit > 0n ? { debit } : { credit }),
      storeId: r.store_id,
      partner: r.partner_type && r.partner_id ? { type: r.partner_type, id: r.partner_id } : null,
    };
  });
};

const sameLines = (a: readonly Line[], b: readonly Line[]): boolean => {
  const key = (l: Line) => `${l.account}|${l.debit ?? 0}|${l.credit ?? 0}|${l.storeId ?? ''}|${l.partner?.type ?? ''}:${l.partner?.id ?? ''}`;
  return JSON.stringify(a.map(key).sort()) === JSON.stringify(b.map(key).sort());
};

const isClosedDay = async (db: Db, day: string): Promise<boolean> => {
  const [year, month] = day.split('-').map(Number);
  const [closed] = await db`select 1 from fiscal_periods where year = ${year!} and month = ${month!} and status = 'closed'`;
  return closed !== undefined;
};

/**
 * Whether a live entry is dated where it should be. The day it should have is `day`, or the
 * first open day after it when that month is closed (what posting it now would give). An entry
 * in a month since closed stays where it is: closed months are final.
 */
const datedRight = async (db: Db, entryDate: string, day: string): Promise<boolean> =>
  entryDate === (await firstOpenDay(db, day)) || (await isClosedDay(db, entryDate));

/**
 * Makes the live entry for a source equal `lines` on `date`: posts it if missing, leaves it if
 * equal, reverses and re-posts it if the amounts changed (a fee PostEx corrected) or its day did
 * (the step that dates it arrived after the amounts), reverses it if it should no longer exist.
 * Which order the facts arrived in never shows in the result. Returns what it did.
 */
export const settle = async (
  db: Db,
  input: { source: Source; lines: readonly Line[] | null; date: string; memo: string; reverseDate?: string },
): Promise<'posted' | 'unchanged' | 'reposted' | 'reversed' | 'none'> => {
  const wanted = input.lines ? normalise(input.lines) : [];
  const live = await liveEntry(db, input.source);
  const sameAmounts = live !== null && wanted.length > 0 && sameLines(live.lines, wanted);
  if (live && sameAmounts && (await datedRight(db, live.date, input.date))) return 'unchanged';
  if (!live && wanted.length === 0) return 'none';
  if (live) {
    await reverseEntry(db, live.id, {
      // A re-dated entry leaves its old day net zero.
      date: sameAmounts ? live.date : (input.reverseDate ?? input.date),
      memo: sameAmounts ? 'Date changed' : wanted.length > 0 ? 'Amounts changed' : 'No longer applies',
      rollForward: true,
    });
    if (wanted.length === 0) return 'reversed';
  }
  await postEntry(db, { date: input.date, memo: input.memo, source: input.source, lines: wanted, rollForward: true });
  return live ? 'reposted' : 'posted';
};

/** A delivery of a parcel, as Karachi days: when it was delivered and, if it was, when that was undone. */
export interface Episode {
  from: string;
  to: string | null;
}

/**
 * Makes a parcel's sale (or COGS) entries equal its delivery episodes: for each delivery, an
 * entry dated on the delivery day, reversed on the day the delivery was undone if it was. What
 * the history says is all that matters, never when the sync saw it, so a parcel first seen
 * already returned gets the same sale and reversal, on the same days, as one watched live; a
 * replay and the live run write identical ledgers.
 *
 * Entries for a delivery the history no longer shows (PostEx corrected itself, the order link or
 * the cost went away) are reversed on `staleDate`. An open delivery whose amounts changed is
 * reversed and re-posted on its own day, as `settle` does. Returns what it did, joined by `+`.
 */
export const settleEpisodes = async (
  db: Db,
  input: { source: Source; lines: readonly Line[] | null; episodes: readonly Episode[]; memo: string; staleDate: string },
): Promise<string> => {
  const wanted = input.lines ? normalise(input.lines) : [];
  const episodes = wanted.length > 0 ? input.episodes : [];
  const chain = await db<{ id: string; occurrence: number; reversed_by: string | null; entry_date: string }[]>`
    select id, occurrence, reversed_by, entry_date::text from journal_entries
    where source_type = ${input.source.type} and source_id = ${input.source.id} order by id
  `;
  const done: string[] = [];
  const post = (episode: Episode, occurrence: number) =>
    postEntry(db, { date: episode.from, memo: input.memo, source: input.source, lines: wanted, rollForward: true, occurrence });

  for (const entry of chain) {
    if (entry.occurrence <= episodes.length || entry.reversed_by) continue;
    await reverseEntry(db, entry.id, { date: input.staleDate, memo: 'No longer applies', rollForward: true });
    done.push('reversed');
  }
  for (const [i, episode] of episodes.entries()) {
    const occurrence = i + 1;
    const own = chain.filter((e) => e.occurrence === occurrence);
    const live = own.find((e) => !e.reversed_by);
    if (episode.to !== null) {
      // A delivery that was undone: its sale exists and is reversed on the day it was undone.
      if (own.length === 0) {
        const posted = await post(episode, occurrence);
        await reverseEntry(db, posted!.id, { date: episode.to, memo: 'Returned after delivery', rollForward: true });
        done.push('posted', 'reversed');
      } else if (live) {
        await reverseEntry(db, live.id, { date: episode.to, memo: 'Returned after delivery', rollForward: true });
        done.push('reversed');
      }
      continue;
    }
    const sameAmounts = live !== undefined && sameLines(await entryLines(db, live.id), wanted);
    if (live && sameAmounts && (await datedRight(db, live.entry_date, episode.from))) continue;
    if (live) await reverseEntry(db, live.id, { date: sameAmounts ? live.entry_date : episode.from, memo: sameAmounts ? 'Date changed' : 'Amounts changed', rollForward: true });
    await post(episode, occurrence);
    done.push(live ? 'reposted' : 'posted');
  }
  if (done.length > 0) return done.join('+');
  return chain.length > 0 ? 'unchanged' : 'none';
};

/** How many entries a set of posting actions wrote (posted, re-posted or reversed). */
export const countPostings = (actions: Record<string, string>): number =>
  Object.values(actions)
    .flatMap((a) => a.split('+'))
    .filter((a) => a === 'posted' || a === 'reposted' || a === 'reversed').length;

// ---- Shipment events ----

const claimTaxSetting = async (db: Db): Promise<boolean> => {
  const [row] = await db<{ value: { claimPostexInputTax?: boolean } }[]>`select value from app_settings where key = 'accounting'`;
  return row?.value.claimPostexInputTax === true;
};

/** Cost of the units a parcel carried out of the warehouse (its booking moves), at the order date. */
const parcelCost = async (
  db: Db,
  shipmentId: string,
  placedAt: Date,
  storeId: string,
  toLocation: 'in_transit' | 'damaged',
): Promise<Paisa | null> => {
  const units = await db<{ variant_id: string; qty: number }[]>`
    select m.variant_id, sum(m.qty)::int as qty from stock_moves m join locations l on l.id = m.to_location_id
    where m.shipment_id = ${shipmentId} and l.key = ${toLocation}
      and (${toLocation} <> 'in_transit' or m.ref_type = 'shipment')
    group by m.variant_id order by m.variant_id
  `;
  let total = ZERO;
  let missing = false;
  for (const unit of units) {
    const cost = await costAt(db, unit.variant_id, placedAt);
    if (cost === null) {
      missing = true;
      // Missing inputs do not block anything (1.10): the item says what is needed.
      await openReviewItem(db, {
        kind: 'cost_missing',
        dedupeKey: `cost_missing:${unit.variant_id}:${karachiDay(placedAt)}`,
        storeId,
        detail: { variantId: unit.variant_id, needCostOn: karachiDay(placedAt) },
      });
      continue;
    }
    total = add(total, paisa(cost * BigInt(unit.qty)));
  }
  return missing ? null : total;
};

export interface ShipmentPostingResult {
  shipmentId: string;
  actions: Record<string, string>;
}

/**
 * The shipment-delivered handler, and the only place revenue is recognised (1.6). Brings the
 * journal in line with a parcel's facts; safe to run any number of times.
 *
 * - Sale and COGS follow the parcel's delivery episodes (`settleEpisodes`): posted on the
 *   delivery day, and reversed on the day a customer return undid the delivery. The ledger is
 *   the same whether the sync saw the parcel delivered first or only after its return.
 * - Forward and return charges are live at PostEx's current amounts, whatever happened to the
 *   parcel: a returned parcel keeps both.
 * - A damaged check-in writes off the cost of the units that came back.
 * An unmatched parcel posts its charges (the account has a store) but no sale: there is no
 * order to say what was sold. Its sale posts once it is linked.
 */
export const postShipmentAccounting = async (sql: Sql, shipmentId: string): Promise<ShipmentPostingResult> =>
  atomically(sql, async (tx) => {
    const [p] = await tx<
      {
        tracking_number: string; postex_account_id: string; account_store: string | null; order_id: string | null; order_store: string | null;
        channel: 'online' | 'consignment' | 'pr' | null; total: string | null; tax: string | null; placed_at: Date | null; cod: string | null;
        booked_at: Date | null; created_at: Date;
      }[]
    >`
      select s.tracking_number, s.postex_account_id, a.store_id as account_store, s.order_id, o.store_id as order_store,
             case when shipment_is_pr(s.id) then 'pr' else o.channel end as channel,
             o.total_paisa::text as total, o.tax_paisa::text as tax, o.placed_at, s.cod_amount_paisa::text as cod, s.booked_at, s.created_at
      from shipments s join postex_accounts a on a.id = s.postex_account_id left join orders o on o.id = s.order_id
      where s.id = ${shipmentId}
    `;
    if (!p) throw new AccountingError(`Shipment ${shipmentId} not found`);
    const actions: Record<string, string> = {};
    const storeId = p.order_store ?? p.account_store;
    if (!storeId) {
      // Nothing can post without a brand; the account's missing store is already queued.
      await tx`update shipments set accounting_pending = false where id = ${shipmentId}`;
      return { shipmentId, actions: { skipped: 'account_has_no_store' } };
    }

    const stored = await tx<{ code: string; message: string; occurred_at: Date | null }[]>`
      select code, message, occurred_at from shipment_events where shipment_id = ${shipmentId}
    `;
    const events: ShipmentEvent[] = stored.map((e) => ({ code: e.code, message: e.message, occurredAt: e.occurred_at, known: Object.hasOwn(POSTEX_STATUS_CODES, e.code) }));
    const pr = p.channel === 'pr';
    const ref = (type: string): Source => ({ type, id: shipmentId });

    // Sale and COGS, one per delivery the history shows.
    const dayOf = (event: ShipmentEvent | null, fallback: string) => (event?.occurredAt ? karachiDay(event.occurredAt) : fallback);
    const bookedDay = karachiDay(p.booked_at ?? p.created_at);
    const episodes: Episode[] = deliveryEpisodes(events).map((e) => {
      const from = dayOf(e.deliveredBy, bookedDay);
      return { from, to: e.endedBy ? dayOf(e.endedBy, from) : null };
    });
    const staleDate = dayOf(parcelTimeline(events).at(-1)?.event ?? null, bookedDay);
    const linked = p.order_id !== null && p.total !== null && p.placed_at !== null;
    const saleWanted =
      linked && !pr
        ? saleLines({
            storeId,
            postexAccountId: p.postex_account_id,
            codAmount: p.cod === null ? readPaisa(p.total!) : readPaisa(p.cod),
            orderTotal: readPaisa(p.total!),
            orderTax: readPaisa(p.tax ?? '0'),
          })
        : null;
    actions['sale'] = await settleEpisodes(tx, { source: ref('shipment_sale'), lines: saleWanted, episodes, staleDate, memo: `Delivered: ${p.tracking_number}` });
    const everDelivered = linked && episodes.length > 0;
    const cost = everDelivered ? await parcelCost(tx, shipmentId, p.placed_at!, storeId, 'in_transit') : null;
    actions['cogs'] = await settleEpisodes(tx, {
      source: ref('shipment_cogs'),
      lines: cost === null ? null : cogsLines({ storeId, cost, pr }),
      episodes,
      staleDate,
      memo: `${pr ? 'PR goods' : 'Cost of goods'} delivered: ${p.tracking_number}`,
    });
    if (everDelivered && cost === null) actions['cogs'] = 'cost_missing';

    // Charges, as PostEx currently reports them.
    const charges = await tx<{ kind: string; amount: string }[]>`select kind, amount_paisa::text as amount from shipment_charges where shipment_id = ${shipmentId}`;
    const charge = (kind: string) => readPaisa(charges.find((c) => c.kind === kind)?.amount ?? '0');
    const claimTax = await claimTaxSetting(tx);
    const base = { storeId, postexAccountId: p.postex_account_id, pr, claimTax };
    actions['forwardCharge'] = await settle(tx, {
      source: ref('shipment_forward_charge'),
      lines: forwardChargeLines({ ...base, fee: charge('forward'), tax: charge('forward_tax') }),
      date: bookedDay,
      memo: `PostEx forward charge: ${p.tracking_number}`,
    });
    // Dated by the return's first step, for the same reason as the reversal above.
    const returnStarted = canonicalOrder(events).find((e) => (e.code === '0040' || e.code === '0006') && e.occurredAt)?.occurredAt;
    actions['returnCharge'] = await settle(tx, {
      source: ref('shipment_return_charge'),
      lines: returnChargeLines({ ...base, fee: charge('reversal'), tax: charge('reversal_tax') }),
      // No return step yet: the booking day, which every later sync agrees on.
      date: returnStarted ? karachiDay(returnStarted) : bookedDay,
      memo: `PostEx return charge: ${p.tracking_number}`,
    });

    // Damaged on check-in: the cost of what came back is written off.
    const [checkIn] = await tx<{ outcome: string; checked_in_at: Date }[]>`select outcome, checked_in_at from return_check_ins where shipment_id = ${shipmentId}`;
    if (checkIn?.outcome === 'damaged' && p.placed_at) {
      const damaged = await parcelCost(tx, shipmentId, p.placed_at, storeId, 'damaged');
      if (damaged !== null) {
        actions['writeOff'] = await settle(tx, {
          source: ref('shipment_write_off'),
          lines: writeOffLines({ storeId, cost: damaged }),
          date: karachiDay(checkIn.checked_in_at),
          memo: `Damaged return written off: ${p.tracking_number}`,
        });
      }
    }
    await tx`update shipments set accounting_pending = false where id = ${shipmentId} and accounting_pending`;
    return { shipmentId, actions };
  });

/** COD received from PostEx for one parcel: posted once per payout line, dated by the CPR. */
export const postPayoutLine = async (db: Db, payoutLineId: string): Promise<Posted | null> => {
  const [line] = await db<{ amount: string; paid_at: Date | null; created_at: Date; cpr: string; account_id: string; store_id: string | null; tracking: string }[]>`
    select l.amount_paisa::text as amount, p.paid_at, p.created_at, p.cpr_number as cpr, p.postex_account_id as account_id,
           a.store_id, s.tracking_number as tracking
    from payout_lines l join cod_payouts p on p.id = l.cod_payout_id join postex_accounts a on a.id = p.postex_account_id
    join shipments s on s.id = l.shipment_id
    where l.id = ${payoutLineId}
  `;
  if (!line) throw new AccountingError(`Payout line ${payoutLineId} not found`);
  if (!line.store_id) return null;
  return postEntry(db, {
    date: karachiDay(line.paid_at ?? line.created_at),
    memo: `COD paid out under ${line.cpr}: ${line.tracking}`,
    source: { type: 'payout_line', id: payoutLineId },
    lines: payoutLines({ storeId: line.store_id, postexAccountId: line.account_id, amount: readPaisa(line.amount) }),
    rollForward: true,
  });
};

// ---- Events with no table of their own yet (Batches F and the consignment UI) ----

export const postVendorBill = (db: Db, bill: VendorBillInput & { billId: string; date: string; postedBy?: string | null }) =>
  postEntry(db, { date: bill.date, memo: `Vendor bill ${bill.billId}`, source: { type: 'vendor_bill', id: bill.billId }, lines: vendorBillLines(bill), postedBy: bill.postedBy ?? null });

export const postVendorPayment = (db: Db, p: { paymentId: string; vendorId: string; amount: Paisa; date: string; postedBy?: string | null }) =>
  postEntry(db, { date: p.date, memo: `Payment to vendor ${p.vendorId}`, source: { type: 'vendor_payment', id: p.paymentId }, lines: vendorPaymentLines(p), postedBy: p.postedBy ?? null });

/** A partner's reported sale: the invoice, and its cost leaving the partner's (still our) stock. */
export const postConsignmentSale = async (db: Db, c: ConsignmentSaleInput & { saleId: string; date: string; postedBy?: string | null }) =>
  atomically(db, async (tx) => ({
    sale: await postEntry(tx, { date: c.date, memo: `Consignment sale ${c.saleId}`, source: { type: 'consignment_sale', id: c.saleId }, lines: consignmentSaleLines(c), postedBy: c.postedBy ?? null }),
    cogs: await postEntry(tx, { date: c.date, memo: `Consignment cost ${c.saleId}`, source: { type: 'consignment_cogs', id: c.saleId }, lines: cogsLines({ storeId: c.storeId, cost: c.cost, pr: false }), postedBy: c.postedBy ?? null }),
  }));

export const postPartnerPayment = (db: Db, p: { paymentId: string; partnerId: string; storeId?: string | null; amount: Paisa; date: string; postedBy?: string | null }) =>
  postEntry(db, { date: p.date, memo: `Payment from partner ${p.partnerId}`, source: { type: 'partner_payment', id: p.paymentId }, lines: partnerPaymentLines(p), postedBy: p.postedBy ?? null });

// ---- Periods and reports ----

/**
 * Closes a Karachi month. Allowed from the 5th of the following month (proposal 6.5 step 6),
 * once, and only when every earlier month with entries is closed; audited. After this the database refuses any entry dated in that month.
 */
export const closePeriod = async (db: Db, input: { year: number; month: number; actorId: string; now?: Date }): Promise<void> =>
  atomically(db, async (tx) => {
    const now = input.now ?? new Date();
    const nextYear = input.month === 12 ? input.year + 1 : input.year;
    const nextMonth = input.month === 12 ? 1 : input.month + 1;
    const earliest = `${nextYear}-${String(nextMonth).padStart(2, '0')}-05`;
    const label = `${input.year}-${String(input.month).padStart(2, '0')}`;
    if (karachiDay(now) < earliest) throw new AccountingError(`Period ${label} can be closed from ${earliest}, not before`);
    const [row] = await tx<{ status: string }[]>`select status from fiscal_periods where year = ${input.year} and month = ${input.month} for update`;
    if (row?.status === 'closed') throw new AccountingError(`Period ${label} is already closed`);
    // Months close in order: a closed month with an open one before it would let entries land
    // behind a close.
    const [earlier] = await tx<{ month: string }[]>`
      select to_char(e.entry_date, 'YYYY-MM') as month from journal_entries e
      where e.entry_date < make_date(${input.year}, ${input.month}, 1)
        and not exists (
          select 1 from fiscal_periods p
          where p.year = extract(year from e.entry_date) and p.month = extract(month from e.entry_date) and p.status = 'closed'
        )
      order by e.entry_date limit 1
    `;
    if (earlier) throw new AccountingError(`Close ${earlier.month} first: months close in order`);
    await tx`
      insert into fiscal_periods (year, month, status, closed_at, closed_by) values (${input.year}, ${input.month}, 'closed', ${now}, ${input.actorId})
      on conflict (year, month) do update set status = 'closed', closed_at = excluded.closed_at, closed_by = excluded.closed_by
    `;
    await tx`
      insert into audit_log (actor_id, action, entity, entity_id, after)
      values (${input.actorId}, 'accounting.close_period', 'fiscal_periods', ${label}, ${tx.json({ closedAt: now.toISOString() })})
    `;
  });

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  debit: Paisa;
  credit: Paisa;
  /** Debit minus credit. */
  balance: Paisa;
}

/** Every account's totals up to a date (inclusive), optionally for one brand. */
export const trialBalance = async (db: Db, options: { to?: string; storeId?: string } = {}): Promise<{ rows: TrialBalanceRow[]; debit: Paisa; credit: Paisa }> => {
  const rows = await db<{ code: string; name: string; type: string; debit: string; credit: string }[]>`
    select a.code, a.name, a.type, coalesce(sum(l.debit_paisa), 0)::text as debit, coalesce(sum(l.credit_paisa), 0)::text as credit
    from accounts a
    join journal_lines l on l.account_id = a.id
    join journal_entries e on e.id = l.entry_id
    where true
      ${options.to ? db`and e.entry_date <= ${options.to}::date` : db``}
      ${options.storeId ? db`and l.store_id = ${options.storeId}` : db``}
    group by a.code, a.name, a.type
    order by a.code
  `;
  const out = rows.map((r) => {
    const debit = readPaisa(r.debit);
    const credit = readPaisa(r.credit);
    return { code: r.code, name: r.name, type: r.type, debit, credit, balance: sub(debit, credit) };
  });
  return { rows: out, debit: sum(out.map((r) => r.debit)), credit: sum(out.map((r) => r.credit)) };
};

/**
 * Rebuilds the journal's view of every parcel and payout from the stored facts (1.10: ledgers
 * are filled by replay). Idempotent: on a journal already in line it posts nothing.
 */
export const replayAccounting = async (
  sql: Sql,
  /** Called after each parcel and payout line, so a script can show how far along the replay is. */
  onProgress?: (done: number, total: number) => void,
): Promise<{ shipments: number; postings: number; payoutLines: number }> => {
  const shipments = await sql<{ id: string }[]>`select id from shipments order by id`;
  const lines = await sql<{ id: string }[]>`select id from payout_lines order by id`;
  const total = shipments.length + lines.length;
  let done = 0;
  let postings = 0;
  for (const { id } of shipments) {
    const { actions } = await postShipmentAccounting(sql, id);
    postings += countPostings(actions);
    onProgress?.(++done, total);
  }
  let payoutLinesPosted = 0;
  for (const { id } of lines) {
    if ((await postPayoutLine(sql, id))?.created) payoutLinesPosted++;
    onProgress?.(++done, total);
  }
  return { shipments: shipments.length, postings, payoutLines: payoutLinesPosted };
};

// ---- Opening balances ----

export const OPENING_SOURCE: Source = { type: 'opening_balance', id: 'opening' };

/** Accounts an opening balance can be entered on: the balance sheet. P&L accounts start at zero. */
export const BALANCE_SHEET_KEYS: readonly AccountKey[] = [
  'bank', 'codReceivable', 'customerReceivable', 'partnerReceivable', 'inventory', 'inputTax', 'payable', 'salesTaxPayable', 'equity',
];

export interface OpeningLine {
  account: AccountKey;
  /** Positive is a debit balance (assets), negative a credit balance (liabilities, equity). */
  balance: Paisa;
  storeId?: string | null;
}

/**
 * The client's opening balances as one entry dated the day before the system takes over. Any
 * difference between the debit and credit balances entered is the owner's opening equity, posted
 * to 3100 Opening balances, so the entry always balances and the gap is visible, not lost.
 * Entering them again replaces the earlier entry by a reversal, while that month is open.
 */
export const openingBalanceLines = (lines: readonly OpeningLine[]): Line[] => {
  const entered = lines.map((l): Line => ({ account: l.account, debit: l.balance, storeId: l.storeId ?? null }));
  const net = sum(lines.map((l) => l.balance));
  return normalise([...entered, { account: 'openingBalances', credit: net }]);
};

export const postOpeningBalances = async (
  db: Db,
  input: { date: string; lines: readonly OpeningLine[]; actorId: string },
): Promise<{ id: string; replaced: boolean } | null> =>
  atomically(db, async (tx) => {
    for (const line of input.lines) {
      if (!BALANCE_SHEET_KEYS.includes(line.account)) throw new AccountingError(`Opening balances go on balance-sheet accounts, not ${ACCOUNT_CODES[line.account]}`);
    }
    const wanted = openingBalanceLines(input.lines);
    const live = await liveEntry(tx, OPENING_SOURCE);
    if (live && sameLines(live.lines, wanted)) return { id: live.id, replaced: false };
    if (live) await reverseEntry(tx, live.id, { date: input.date, memo: 'Opening balances re-entered', postedBy: input.actorId });
    const posted = await postEntry(tx, { date: input.date, memo: 'Opening balances', source: OPENING_SOURCE, lines: wanted, postedBy: input.actorId });
    await tx`
      insert into audit_log (actor_id, action, entity, entity_id, before, after)
      values (${input.actorId}, 'accounting.opening_balances', 'journal_entries', ${posted?.id ?? null},
              ${live ? tx.json({ entryId: live.id }) : null},
              ${tx.json({ date: input.date, lines: input.lines.map((l) => ({ account: ACCOUNT_CODES[l.account], balance: l.balance.toString(), storeId: l.storeId ?? null })) })})
    `;
    return posted ? { id: posted.id, replaced: live !== null } : null;
  });

export const openingBalances = async (db: Db): Promise<{ date: string; lines: OpeningLine[] } | null> => {
  const live = await liveEntry(db, OPENING_SOURCE);
  if (!live) return null;
  const [entry] = await db<{ entry_date: string }[]>`select entry_date::text from journal_entries where id = ${live.id}`;
  return {
    date: entry!.entry_date,
    lines: live.lines
      .filter((l) => l.account !== 'openingBalances')
      .map((l) => ({ account: l.account, balance: l.debit ?? paisa(-(l.credit ?? ZERO)), storeId: l.storeId ?? null })),
  };
};

// ---- Periods and ledgers for the screens ----

export interface PeriodView {
  year: number;
  month: number;
  status: 'open' | 'closed';
  closedAt: Date | null;
  closedBy: string | null;
  entries: number;
  /** The first Karachi day it may be closed: the 5th of the next month. */
  closableFrom: string;
}

const closableFrom = (year: number, month: number): string =>
  `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-05`;

/** Every month from the first entry (or this month) to this month, newest first. */
export const listPeriods = async (db: Db, now: Date = new Date()): Promise<PeriodView[]> => {
  const rows = await db<{ year: number; month: number; status: 'open' | 'closed'; closed_at: Date | null; closed_by: string | null; entries: number }[]>`
    with bounds as (
      select date_trunc('month', least(coalesce(min(entry_date), ${karachiDay(now)}::date), ${karachiDay(now)}::date)) as first_month
      from journal_entries
    ),
    months as (
      select generate_series((select first_month from bounds), date_trunc('month', ${karachiDay(now)}::date), interval '1 month')::date as m
    )
    select extract(year from m)::int as year, extract(month from m)::int as month,
           coalesce(p.status, 'open') as status, p.closed_at, u.email as closed_by,
           (select count(*)::int from journal_entries e where date_trunc('month', e.entry_date) = m) as entries
    from months
    left join fiscal_periods p on p.year = extract(year from m) and p.month = extract(month from m)
    left join users u on u.id = p.closed_by
    order by m desc
  `;
  return rows.map((r) => ({ year: r.year, month: r.month, status: r.status, closedAt: r.closed_at, closedBy: r.closed_by, entries: r.entries, closableFrom: closableFrom(r.year, r.month) }));
};

export interface LedgerLine {
  entryId: string;
  date: string;
  memo: string;
  sourceType: string;
  sourceId: string;
  storeId: string | null;
  debit: Paisa;
  credit: Paisa;
  reversed: boolean;
}

/** One account's lines, newest first: what a trial balance figure is made of. */
export const accountLedger = async (db: Db, code: string, options: { to?: string; storeId?: string; limit?: number } = {}): Promise<LedgerLine[]> => {
  const rows = await db<{ entry_id: string; date: string; memo: string; source_type: string; source_id: string; store_id: string | null; debit: string; credit: string; reversed: boolean }[]>`
    select e.id as entry_id, e.entry_date::text as date, e.memo, e.source_type, e.source_id, l.store_id,
           l.debit_paisa::text as debit, l.credit_paisa::text as credit, e.reversed_by is not null as reversed
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where a.code = ${code}
      ${options.to ? db`and e.entry_date <= ${options.to}::date` : db``}
      ${options.storeId ? db`and l.store_id = ${options.storeId}` : db``}
    order by e.entry_date desc, e.id desc
    limit ${options.limit ?? 200}
  `;
  return rows.map((r) => ({
    entryId: r.entry_id, date: r.date, memo: r.memo, sourceType: r.source_type, sourceId: r.source_id, storeId: r.store_id,
    debit: readPaisa(r.debit), credit: readPaisa(r.credit), reversed: r.reversed,
  }));
};

// ---- Checks for the opening figures ----

/** Where the business still owns the goods: everything but sold, PR'd, written off, or not yet bought. */
const OWNED_KINDS = ['warehouse', 'partner', 'in_transit', 'returning'];

export interface InventoryCheck {
  asAt: string;
  /** Units the stock ledger says are owned at the end of that day, each at its cost on that day. */
  stockValue: Paisa;
  /** The Inventory account (1300) balance on that day. */
  ledgerValue: Paisa;
  /** Ledger minus stock: zero when the books and the count agree. */
  difference: Paisa;
  variants: number;
  units: number;
  /** Units held with no cost on that date: their value is missing from `stockValue`. */
  missingCost: Array<{ variantId: string; sku: string | null; title: string; units: number }>;
  /** Variants whose owned units are below zero: stock that left before it was counted in. */
  negative: Array<{ variantId: string; sku: string | null; title: string; units: number }>;
}

/**
 * Do the books and the stock count agree? The Inventory account against units × cost, both as at
 * the end of one Karachi day. On the cut-over date this checks the opening Inventory balance
 * against the opening stock count; later on, a difference means stock moved without a posting
 * (a count correction) or costs changed since the goods were costed.
 */
export const inventoryCheck = async (db: Db, asAt: string): Promise<InventoryCheck> => {
  const end = endOfKarachiDay(asAt);
  const rows = await db<{ variant_id: string; sku: string | null; title: string; units: number }[]>`
    select v.id as variant_id, v.sku, p.title || ' · ' || v.title as title, sum(m.units)::int as units
    from (
      select variant_id, qty as units, to_location_id as location_id, occurred_at from stock_moves
      union all
      select variant_id, -qty, from_location_id, occurred_at from stock_moves
    ) m
    join locations l on l.id = m.location_id
    join variants v on v.id = m.variant_id
    join products p on p.id = v.product_id
    where l.kind = any(${OWNED_KINDS}::text[]) and m.occurred_at <= ${end}
    group by v.id, v.sku, p.title, v.title
    having sum(m.units) <> 0
    order by p.title, v.title
  `;
  let stockValue = ZERO;
  const missingCost: InventoryCheck['missingCost'] = [];
  for (const row of rows) {
    const cost = await costAt(db, row.variant_id, end);
    if (cost === null) {
      missingCost.push({ variantId: row.variant_id, sku: row.sku, title: row.title, units: row.units });
      continue;
    }
    stockValue = add(stockValue, paisa(cost * BigInt(row.units)));
  }
  const [ledger] = await db<{ balance: string }[]>`
    select coalesce(sum(l.debit_paisa - l.credit_paisa), 0)::text as balance
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where a.code = ${ACCOUNT_CODES.inventory} and e.entry_date <= ${asAt}::date
  `;
  const ledgerValue = readPaisa(ledger!.balance);
  return {
    asAt,
    stockValue,
    ledgerValue,
    difference: sub(ledgerValue, stockValue),
    variants: rows.length,
    units: rows.reduce((n, r) => n + r.units, 0),
    missingCost,
    negative: rows.filter((r) => r.units < 0).map((r) => ({ variantId: r.variant_id, sku: r.sku, title: r.title, units: r.units })),
  };
};

/**
 * Entries other than the opening balances dated on or before the opening date. Opening balances
 * must be the first thing in the books: anything dated earlier is history the client's own
 * balances already include, so it would be counted twice.
 */
export const entriesBeforeOpening = async (db: Db): Promise<{ count: number; earliest: string | null }> => {
  const [row] = await db<{ count: number; earliest: string | null }[]>`
    select count(*)::int as count, min(e.entry_date)::text as earliest
    from journal_entries e
    where e.source_type <> 'opening_balance' and e.reverses_id is null
      and e.entry_date <= (select entry_date from journal_entries where source_type = 'opening_balance' and reversed_by is null)
  `;
  return { count: row?.count ?? 0, earliest: row?.earliest ?? null };
};
