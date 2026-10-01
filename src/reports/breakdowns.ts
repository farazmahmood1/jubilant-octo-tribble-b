import { type Db, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, sub, sum } from '../lib/money.js';
import { type Fragment, type ReportFilter, ledgerWhere, prefix } from './filter.js';

/**
 * The headline figures split by one dimension, from the same ledger lines as the P&L, so the
 * rows of any breakdown add up to the P&L for the same filter.
 *
 * | Dimension    | Group                                                                  |
 * |--------------|------------------------------------------------------------------------|
 * | `store`      | the brand on the line (NUR by Juggun, Juggun's Organics); each brand is its own store |
 * | `month`      | the entry's Karachi month                                               |
 * | `city`       | the parcel's delivery city; lines with no parcel are "(no parcel)"      |
 * | `partner`    | the retail partner of a consignment sale; only consignment lines        |
 * | `influencer` | the order's first discount code (influencer codes, until Batch H's table exists) |
 * | `agent`      | the confirmation agent: not recorded until the Confirmation Desk (Step 11), so one "(not recorded)" group |
 *
 * `product` cannot come from the ledger, which records a sale per parcel, not per item; see
 * `productBreakdown`.
 */
export const DIMENSIONS = ['store', 'month', 'city', 'partner', 'influencer', 'agent'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface BreakdownRow {
  key: string;
  label: string;
  revenue: Paisa;
  goods: Paisa;
  postexCharges: Paisa;
  marketing: Paisa;
  writeOff: Paisa;
  otherExpenses: Paisa;
  profit: Paisa;
  parcels: number;
}

const partnerOf = (db: Db): Fragment => db`(
  select jl.partner_id from journal_entries je join journal_lines jl on jl.entry_id = je.id
  where je.source_type = 'consignment_sale' and je.source_id = l.origin_id and jl.partner_type = 'retail_partner'
  limit 1
)`;

const keyOf = (db: Db, dimension: Dimension): { key: Fragment; label: Fragment; where: Fragment } => {
  switch (dimension) {
    case 'store':
      return { key: db`coalesce(st.key, '-')`, label: db`coalesce(st.label, '(both brands)')`, where: db`` };
    case 'month':
      return { key: db`to_char(l.entry_date, 'YYYY-MM')`, label: db`to_char(l.entry_date, 'YYYY-MM')`, where: db`` };
    case 'city':
      return { key: db`coalesce(lower(trim(s.city)), '-')`, label: db`coalesce(min(s.city), '(no parcel)')`, where: db`` };
    case 'partner':
      return {
        key: db`coalesce(${partnerOf(db)}::text, '-')`,
        label: db`coalesce((select rp.name from retail_partners rp where rp.id = ${partnerOf(db)}), '(unknown partner)')`,
        where: db`and l.origin_type in ('consignment_sale', 'consignment_cogs')`,
      };
    case 'influencer':
      return { key: db`coalesce(lower(o.discount_codes[1]), '-')`, label: db`coalesce(o.discount_codes[1], '(no code)')`, where: db`` };
    case 'agent':
      return { key: db`'-'`, label: db`'(not recorded)'`, where: db`` };
  }
};

const grouped = (db: Db, f: ReportFilter, dimension: Dimension) => {
  const { key, label, where } = keyOf(db, dimension);
  return db`
    select ${key} as key, ${dimension === 'city' ? label : db`min(${label})`} as label,
           coalesce(sum(l.credit_paisa - l.debit_paisa) filter (where l.account_type = 'income'), 0) as revenue,
           coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code = '5000'), 0) as goods,
           coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code in ('6000', '6010', '6020')), 0) as charges,
           coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code = '6100'), 0) as marketing,
           coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code = '6200'), 0) as write_off,
           coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_type = 'expense' and l.account_code not in ('5000', '6000', '6010', '6020', '6100', '6200')), 0) as other,
           count(distinct l.shipment_id)::int as parcels
    from ledger_lines l
    left join shipments s on s.id = l.shipment_id
    left join orders o on o.id = s.order_id
    left join stores st on st.id = l.store_id
    where l.account_type in ('income', 'expense') ${where} ${ledgerWhere(db, f)}
    group by 1
  `;
};

const query = (db: Db, f: ReportFilter, dimension: Dimension, explain = false) =>
  db<{ key: string; label: string; revenue: string; goods: string; charges: string; marketing: string; write_off: string; other: string; parcels: number }[]>`
    ${prefix(db, explain)}
    select g.key, g.label, g.revenue::text, g.goods::text, g.charges::text, g.marketing::text, g.write_off::text, g.other::text, g.parcels
    from (${grouped(db, f, dimension)}) g
    order by g.revenue desc, g.key
  `;

export const breakdown = async (db: Db, dimension: Dimension, f: ReportFilter = {}): Promise<BreakdownRow[]> =>
  (await query(db, f, dimension)).map((r) => {
    const revenue = readPaisa(r.revenue);
    const goods = readPaisa(r.goods);
    const postexCharges = readPaisa(r.charges);
    const marketing = readPaisa(r.marketing);
    const writeOff = readPaisa(r.write_off);
    const otherExpenses = readPaisa(r.other);
    const costs = sum([goods, postexCharges, marketing, writeOff, otherExpenses]);
    return { key: r.key, label: r.label, revenue, goods, postexCharges, marketing, writeOff, otherExpenses, profit: sub(revenue, costs), parcels: r.parcels };
  });

export const explainBreakdown = (db: Db, dimension: Dimension, f: ReportFilter = {}) => query(db, f, dimension, true);

/** The parcels and journal entries in one group of a breakdown. */
export const drillBreakdown = async (db: Db, dimension: Dimension, key: string, f: ReportFilter = {}): Promise<{ shipmentIds: string[]; entryIds: string[] }> => {
  const { key: keyExpr, where } = keyOf(db, dimension);
  const rows = await db<{ shipment_id: string | null; entry_id: string }[]>`
    select l.shipment_id::text, l.entry_id from ledger_lines l
    left join shipments s on s.id = l.shipment_id
    left join orders o on o.id = s.order_id
    left join stores st on st.id = l.store_id
    where l.account_type in ('income', 'expense') ${where} ${ledgerWhere(db, f)} and ${keyExpr} = ${key}
    order by l.entry_id
  `;
  return {
    shipmentIds: [...new Set(rows.flatMap((r) => (r.shipment_id ? [r.shipment_id] : [])))],
    entryIds: [...new Set(rows.map((r) => r.entry_id))],
  };
};

/**
 * Per product: units and item sales on the parcels whose sale is live in the period, and the
 * goods' cost at the order date. From the order lines, not the ledger (which records one sale
 * per parcel): item sales exclude shipping and order-level discounts, so the column will not
 * equal ledger revenue. Units are what the parcels carried out of the warehouse.
 */
export interface ProductRow {
  variantId: string;
  store: string;
  sku: string | null;
  title: string;
  units: number;
  itemSales: Paisa;
  /** Null when a unit has no cost at its order date (a `cost_missing` item says so). */
  goodsCost: Paisa | null;
}

const productQuery = (db: Db, f: ReportFilter, explain = false) =>
  db<{ variant_id: string; store: string; sku: string | null; title: string; units: number; item_sales: string; goods_cost: string | null }[]>`
    ${prefix(db, explain)}
    with delivered as (
      select e.source_id::bigint as shipment_id from journal_entries e
      where e.source_type = 'shipment_sale' and e.reversed_by is null
        ${f.from ? db`and e.entry_date >= ${f.from}::date` : db``} ${f.to ? db`and e.entry_date <= ${f.to}::date` : db``}
    ),
    items as (
      select ol.variant_id, ol.qty, ol.total_paisa, o.placed_at
      from delivered d
      join shipments s on s.id = d.shipment_id
      join orders o on o.id = s.order_id
      join order_lines ol on ol.order_id = o.id
      where ol.variant_id is not null and ol.qty > 0
        ${f.store ? db`and o.store_id = (select id from stores where key = ${f.store})` : db``}
    )
    select v.id as variant_id, st.key as store, v.sku, p.title || ' · ' || v.title as title,
           sum(i.qty)::int as units, sum(i.total_paisa)::text as item_sales,
           case when bool_and(c.unit_cost_paisa is not null) then sum(i.qty * c.unit_cost_paisa)::text end as goods_cost
    from items i
    join variants v on v.id = i.variant_id
    join products p on p.id = v.product_id
    join stores st on st.id = v.store_id
    left join lateral (
      select pc.unit_cost_paisa from product_costs pc
      where pc.variant_id = i.variant_id and pc.effective_from <= (i.placed_at at time zone 'Asia/Karachi')::date
      order by pc.effective_from desc, pc.id desc limit 1
    ) c on true
    group by v.id, st.key, v.sku, p.title, v.title
    order by sum(i.total_paisa) desc, v.id
  `;

export const productBreakdown = async (db: Db, f: ReportFilter = {}): Promise<ProductRow[]> =>
  (await productQuery(db, f)).map((r) => ({
    variantId: r.variant_id,
    store: r.store,
    sku: r.sku,
    title: r.title,
    units: r.units,
    itemSales: readPaisa(r.item_sales),
    goodsCost: r.goods_cost === null ? null : readPaisa(r.goods_cost),
  }));

export const explainProductBreakdown = (db: Db, f: ReportFilter = {}) => productQuery(db, f, true);

/** The orders behind one product's row. */
export const drillProductBreakdown = async (db: Db, variantId: string, f: ReportFilter = {}): Promise<{ orderIds: string[]; shipmentIds: string[] }> => {
  const rows = await db<{ order_id: string; shipment_id: string }[]>`
    select distinct o.id as order_id, s.id::text as shipment_id
    from journal_entries e
    join shipments s on s.id = e.source_id::bigint
    join orders o on o.id = s.order_id
    join order_lines ol on ol.order_id = o.id
    where e.source_type = 'shipment_sale' and e.reversed_by is null and ol.variant_id = ${variantId}
      ${f.from ? db`and e.entry_date >= ${f.from}::date` : db``} ${f.to ? db`and e.entry_date <= ${f.to}::date` : db``}
    order by o.id
  `;
  return { orderIds: [...new Set(rows.map((r) => r.order_id))], shipmentIds: [...new Set(rows.map((r) => r.shipment_id))] };
};
