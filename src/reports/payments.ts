import { type Db, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, add, sub, sum } from '../lib/money.js';

/**
 * What PostEx paid out in the last hours, order by order, and what each order made. A payment is
 * placed in the window by the time on its receipt (CPR). For each order: the payment (its COD less
 * PostEx's forward charge and that charge's tax, which PostEx keeps before paying), the charges as
 * PostEx reports them, and the profit of the parcels paid, from the books: revenue less the goods,
 * PostEx's charges with their tax, marketing and write-off, as the profit-per-parcel report gives
 * each parcel. A parcel with no Shopify order is a row of its own, named by its tracking number.
 */

export const PAYMENT_WINDOWS = { '24h': 24, '7d': 7 * 24, '14d': 14 * 24, '30d': 30 * 24 } as const;
export type PaymentWindow = keyof typeof PAYMENT_WINDOWS;
export const PAYMENT_WINDOW_KEYS = Object.keys(PAYMENT_WINDOWS) as [PaymentWindow, ...PaymentWindow[]];

export interface PaymentRow {
  orderId: string | null;
  orderNumber: string | null;
  store: string | null;
  trackingNumbers: string[];
  /** The latest receipt time among the order's parcels paid in the window. */
  paidAt: Date;
  cprNumbers: string[];
  /** What PostEx paid out on these parcels. */
  payment: Paisa;
  /** The cash on delivery the customer handed over. */
  cod: Paisa;
  deliveryFee: Paisa;
  deliveryTax: Paisa;
  revenue: Paisa;
  goods: Paisa;
  /** Marketing and write-off on these parcels, which the profit also takes off. */
  other: Paisa;
  profit: Paisa;
}

export interface PaymentsReport {
  window: PaymentWindow;
  since: Date;
  until: Date;
  /** The newest payment up to `until`, in or before the window: PostEx pays in batches days apart, so an empty day can say when the last one was. */
  lastPaidAt: Date | null;
  rows: PaymentRow[];
  totals: { orders: number; parcels: number; payment: Paisa; cod: Paisa; deliveryFee: Paisa; deliveryTax: Paisa; revenue: Paisa; goods: Paisa; profit: Paisa };
}

const ofStore = (db: Db, store: string | undefined) =>
  store ? db`and p.postex_account_id in (select a.id from postex_accounts a join stores st on st.id = a.store_id where st.key = ${store})` : db``;

const query = (db: Db, since: Date, until: Date, store: string | undefined) =>
  db<{
    shipment_id: string; tracking_number: string; order_id: string | null; order_number: string | null; store: string | null; paid_at: Date; cprs: string[];
    payment: string; cod: string; fee: string; tax: string; revenue: string; goods: string; charges: string; other: string;
  }[]>`
    with paid as (
      select l.shipment_id, sum(l.amount_paisa) as payment, max(p.paid_at) as paid_at, array_agg(distinct p.cpr_number) as cprs
      from payout_lines l
      join cod_payouts p on p.id = l.cod_payout_id
      where p.paid_at >= ${since} and p.paid_at <= ${until} ${ofStore(db, store)}
      group by l.shipment_id
    ),
    books as (
      select l.shipment_id,
             coalesce(sum(l.credit_paisa - l.debit_paisa) filter (where l.account_code = '4000'), 0) as revenue,
             coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code = '5000'), 0) as goods,
             coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code in ('6000', '6010', '6020')), 0) as charges,
             coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code in ('6100', '6200')), 0) as other
      from ledger_lines l
      where l.shipment_id in (select shipment_id from paid) and l.account_type in ('income', 'expense')
      group by l.shipment_id
    )
    select s.id::text as shipment_id, s.tracking_number, s.order_id::text, o.order_number, st.key as store, paid.paid_at, paid.cprs,
           paid.payment::text, coalesce(s.cod_amount_paisa, 0)::text as cod,
           coalesce((select sum(c.amount_paisa) from shipment_charges c where c.shipment_id = s.id and c.kind in ('forward', 'reversal')), 0)::text as fee,
           coalesce((select sum(c.amount_paisa) from shipment_charges c where c.shipment_id = s.id and c.kind in ('forward_tax', 'reversal_tax')), 0)::text as tax,
           coalesce(b.revenue, 0)::text as revenue, coalesce(b.goods, 0)::text as goods, coalesce(b.charges, 0)::text as charges, coalesce(b.other, 0)::text as other
    from paid
    join shipments s on s.id = paid.shipment_id
    join postex_accounts a on a.id = s.postex_account_id
    left join stores st on st.id = a.store_id
    left join orders o on o.id = s.order_id
    left join books b on b.shipment_id = s.id
    order by paid.paid_at desc, s.id desc
  `;

export const paymentsReport = async (db: Db, options: { window: PaymentWindow; store?: string; now?: Date }): Promise<PaymentsReport> => {
  const until = options.now ?? new Date();
  const since = new Date(until.getTime() - PAYMENT_WINDOWS[options.window] * 3_600_000);
  const rows: PaymentRow[] = [];
  const byOrder = new Map<string, PaymentRow>();
  // Newest payment first, so an order's row takes the place of its latest parcel.
  for (const r of await query(db, since, until, options.store)) {
    const revenue = readPaisa(r.revenue);
    const goods = readPaisa(r.goods);
    const other = readPaisa(r.other);
    const parcel: PaymentRow = {
      orderId: r.order_id,
      orderNumber: r.order_number,
      store: r.store,
      trackingNumbers: [r.tracking_number],
      paidAt: r.paid_at,
      cprNumbers: [...r.cprs].sort(),
      payment: readPaisa(r.payment),
      cod: readPaisa(r.cod),
      deliveryFee: readPaisa(r.fee),
      deliveryTax: readPaisa(r.tax),
      revenue,
      goods,
      other,
      profit: sub(sub(sub(revenue, goods), readPaisa(r.charges)), other),
    };
    const seen = r.order_id ? byOrder.get(r.order_id) : undefined;
    if (!seen) {
      rows.push(parcel);
      if (r.order_id) byOrder.set(r.order_id, parcel);
      continue;
    }
    seen.trackingNumbers.push(r.tracking_number);
    seen.cprNumbers = [...new Set([...seen.cprNumbers, ...parcel.cprNumbers])].sort();
    for (const key of ['payment', 'cod', 'deliveryFee', 'deliveryTax', 'revenue', 'goods', 'other', 'profit'] as const) seen[key] = add(seen[key], parcel[key]);
  }
  const total = (key: 'payment' | 'cod' | 'deliveryFee' | 'deliveryTax' | 'revenue' | 'goods' | 'profit') => sum(rows.map((r) => r[key]));
  const [last] = await db<{ at: Date | null }[]>`
    select max(p.paid_at) as at from cod_payouts p where p.paid_at <= ${until} ${ofStore(db, options.store)}
  `;
  return {
    window: options.window,
    since,
    until,
    lastPaidAt: last?.at ?? null,
    rows,
    totals: {
      orders: rows.length,
      parcels: rows.reduce((n, r) => n + r.trackingNumbers.length, 0),
      payment: total('payment'),
      cod: total('cod'),
      deliveryFee: total('deliveryFee'),
      deliveryTax: total('deliveryTax'),
      revenue: total('revenue'),
      goods: total('goods'),
      profit: total('profit'),
    },
  };
};
