import { type Db, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, ZERO, add, allocate, sub, sum } from '../lib/money.js';
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
 * | `influencer` | the influencer whose code the order used (`influencer_codes`, per store, any case); an order with codes but none assigned groups by its first code, marked unassigned |
 * | `agent`      | the Confirmation Desk agent who confirmed the order (their latest confirmed or changed attempt); "(not confirmed at the desk)" otherwise |
 *
 * `product` splits each parcel's ledger lines across its items; see `productBreakdown`.
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

/**
 * An order is attributed to the first of its discount codes that is an influencer's code in the
 * order's store, so a sitewide code typed alongside one does not hide the influencer.
 */
const influencerJoin = (db: Db): Fragment => db`
  left join lateral (
    select ic.influencer_id from unnest(o.discount_codes) with ordinality as used (code, n)
    join influencer_codes ic on ic.store_id = o.store_id and lower(ic.discount_code) = lower(used.code)
    order by used.n limit 1
  ) inf on true
  left join influencers i on i.id = inf.influencer_id
`;

/** The agent behind the order's standing confirmation: their latest confirmed or changed attempt. */
const agentJoin = (db: Db): Fragment => db`
  left join lateral (
    select a.agent_id from confirmations cf join confirmation_attempts a on a.confirmation_id = cf.id
    where cf.order_id = o.id and cf.state in ('confirmed', 'changed') and a.outcome in ('confirmed', 'changed')
    order by a.at desc, a.id desc limit 1
  ) confirmer on true
  left join users agent on agent.id = confirmer.agent_id
`;

const keyOf = (db: Db, dimension: Dimension): { key: Fragment; label: Fragment; where: Fragment; join: Fragment } => {
  const none: Fragment = db``;
  switch (dimension) {
    case 'store':
      return { key: db`coalesce(st.key, '-')`, label: db`coalesce(st.label, '(both brands)')`, where: none, join: none };
    case 'month':
      return { key: db`to_char(l.entry_date, 'YYYY-MM')`, label: db`to_char(l.entry_date, 'YYYY-MM')`, where: none, join: none };
    case 'city':
      return { key: db`coalesce(lower(trim(s.city)), '-')`, label: db`coalesce(min(s.city), '(no parcel)')`, where: none, join: none };
    case 'partner':
      return {
        key: db`coalesce(${partnerOf(db)}::text, '-')`,
        label: db`coalesce((select rp.name from retail_partners rp where rp.id = ${partnerOf(db)}), '(unknown partner)')`,
        where: db`and l.origin_type in ('consignment_sale', 'consignment_cogs')`,
        join: none,
      };
    case 'influencer':
      return {
        key: db`coalesce('influencer:' || i.id, 'code:' || lower(o.discount_codes[1]), '-')`,
        label: db`coalesce(i.name || ' (@' || i.handle || ')', o.discount_codes[1] || ' (unassigned code)', '(no influencer code)')`,
        where: none,
        join: influencerJoin(db),
      };
    case 'agent':
      return { key: db`coalesce(agent.id::text, '-')`, label: db`coalesce(agent.name, '(not confirmed at the desk)')`, where: none, join: agentJoin(db) };
  }
};

const grouped = (db: Db, f: ReportFilter, dimension: Dimension) => {
  const { key, label, where, join } = keyOf(db, dimension);
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
    ${join}
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
  const { key: keyExpr, where, join } = keyOf(db, dimension);
  const rows = await db<{ shipment_id: string | null; entry_id: string }[]>`
    select l.shipment_id::text, l.entry_id from ledger_lines l
    left join shipments s on s.id = l.shipment_id
    left join orders o on o.id = s.order_id
    left join stores st on st.id = l.store_id
    ${join}
    where l.account_type in ('income', 'expense') ${where} ${ledgerWhere(db, f)} and ${keyExpr} = ${key}
    order by l.entry_id
  `;
  return {
    shipmentIds: [...new Set(rows.flatMap((r) => (r.shipment_id ? [r.shipment_id] : [])))],
    entryIds: [...new Set(rows.map((r) => r.entry_id))],
  };
};

/**
 * Per product, from the ledger. The ledger records one sale and one COGS entry per parcel, so
 * each parcel's revenue (4000) and cost of goods (5000) in the period are split across the items
 * on its order: revenue by what each line sold for after its own discount, cost by each line's
 * units at their cost on the order date (how COGS was posted). The split is exact to the paisa, so the rows add up to
 * the parcels' revenue and COGS in the P&L for the same filter, shipping and order-level discounts
 * included (they are spread with the rest). A reversal splits the same way, so a customer return
 * takes its units and revenue back out of the period it lands in.
 *
 * Two rows hold what has no product: items not linked to a variant (`unmapped`), and parcels
 * whose order has no lines (`no_lines`). PR parcels sell nothing and are not here; consignment
 * sales are per partner, in the partner breakdown.
 */
export interface ProductRow {
  /** The variant id, or `unmapped` / `no_lines`. */
  key: string;
  variantId: string | null;
  store: string | null;
  sku: string | null;
  title: string;
  /** Units delivered, net of units returned after delivery, in the period. */
  units: number;
  revenue: Paisa;
  goods: Paisa;
  grossProfit: Paisa;
  parcels: number;
}

export interface ProductBreakdown {
  rows: ProductRow[];
  /** Parcel revenue and COGS in the ledger for the filter: what the rows add up to. */
  revenue: Paisa;
  goods: Paisa;
}

interface ProductLine {
  shipment_id: string;
  revenue: string;
  goods: string;
  sales: number;
  variant_id: string | null;
  has_line: boolean;
  qty: number | null;
  line_total: string | null;
  unit_cost: string | null;
  store: string | null;
  sku: string | null;
  title: string | null;
}

const productQuery = (db: Db, f: ReportFilter, explain = false) =>
  db<ProductLine[]>`
    ${prefix(db, explain)}
    with moved as (
      select l.shipment_id,
             coalesce(sum(l.credit_paisa - l.debit_paisa) filter (where l.account_code = '4000'), 0) as revenue,
             coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code = '5000'), 0) as goods,
             count(distinct l.entry_id) filter (where l.origin_type = 'shipment_sale' and not l.is_reversal)
               - count(distinct l.entry_id) filter (where l.origin_type = 'shipment_sale' and l.is_reversal) as sales
      from ledger_lines l
      where l.origin_type in ('shipment_sale', 'shipment_cogs') ${ledgerWhere(db, f)}
      group by l.shipment_id
    )
    select m.shipment_id::text, m.revenue::text, m.goods::text, m.sales::int, ol.variant_id::text, ol.id is not null as has_line,
           ol.qty, ol.total_paisa::text as line_total, c.unit_cost_paisa::text as unit_cost,
           st.key as store, coalesce(v.sku, ol.sku) as sku, coalesce(p.title || case when v.title = 'Default Title' then '' else ' · ' || v.title end, ol.title) as title
    from moved m
    join shipments s on s.id = m.shipment_id
    left join orders o on o.id = s.order_id
    left join stores st on st.id = o.store_id
    left join order_lines ol on ol.order_id = o.id and ol.qty > 0
    left join variants v on v.id = ol.variant_id
    left join products p on p.id = v.product_id
    left join lateral (
      select pc.unit_cost_paisa from product_costs pc
      where pc.variant_id = ol.variant_id and pc.effective_from <= (o.placed_at at time zone 'Asia/Karachi')::date
      order by pc.effective_from desc, pc.id desc limit 1
    ) c on true
    where m.revenue <> 0 or m.goods <> 0 or m.sales <> 0
    order by m.shipment_id, ol.id
  `;

const keyOfLine = (line: ProductLine): string => (!line.has_line ? 'no_lines' : (line.variant_id ?? 'unmapped'));

export const productBreakdown = async (db: Db, f: ReportFilter = {}): Promise<ProductBreakdown> => {
  const byParcel = new Map<string, ProductLine[]>();
  for (const line of await productQuery(db, f)) byParcel.set(line.shipment_id, [...(byParcel.get(line.shipment_id) ?? []), line]);

  const rows = new Map<string, ProductRow & { parcelIds: Set<string> }>();
  let revenue = ZERO;
  let goods = ZERO;
  for (const [shipmentId, lines] of byParcel) {
    const first = lines[0]!;
    const parcelRevenue = readPaisa(first.revenue);
    const parcelGoods = readPaisa(first.goods);
    revenue = add(revenue, parcelRevenue);
    goods = add(goods, parcelGoods);
    // Revenue by what each line sold for; cost by units × cost, as COGS was posted: an item with no
    // product carried no stock out of the warehouse and so no cost.
    const revenueParts = allocate(parcelRevenue, lines.map((l) => BigInt(l.line_total ?? '0')));
    const goodsParts = allocate(parcelGoods, lines.map((l) => (l.variant_id && l.unit_cost ? BigInt(l.qty ?? 0) * BigInt(l.unit_cost) : 0n)));
    for (const [i, line] of lines.entries()) {
      const key = keyOfLine(line);
      const row = rows.get(key) ?? {
        key,
        variantId: line.variant_id,
        store: key === 'unmapped' || key === 'no_lines' ? null : line.store,
        sku: key === 'unmapped' || key === 'no_lines' ? null : line.sku,
        title: key === 'no_lines' ? '(parcels whose order has no lines)' : key === 'unmapped' ? '(items not linked to a product)' : (line.title ?? key),
        units: 0,
        revenue: ZERO,
        goods: ZERO,
        grossProfit: ZERO,
        parcels: 0,
        parcelIds: new Set<string>(),
      };
      row.units += (line.qty ?? 0) * first.sales;
      row.revenue = add(row.revenue, revenueParts[i]!);
      row.goods = add(row.goods, goodsParts[i]!);
      row.parcelIds.add(shipmentId);
      rows.set(key, row);
    }
  }
  return {
    revenue,
    goods,
    rows: [...rows.values()]
      .map(({ parcelIds, ...row }) => ({ ...row, grossProfit: sub(row.revenue, row.goods), parcels: parcelIds.size }))
      .sort((a, b) => (a.revenue === b.revenue ? (a.key < b.key ? -1 : 1) : a.revenue > b.revenue ? -1 : 1)),
  };
};

export const explainProductBreakdown = (db: Db, f: ReportFilter = {}) => productQuery(db, f, true);

/** The parcels, orders and journal entries behind one product row (`key` as on the row). */
export const drillProductBreakdown = async (
  db: Db,
  key: string,
  f: ReportFilter = {},
): Promise<{ orderIds: string[]; shipmentIds: string[]; entryIds: string[] }> => {
  const rows = await db<{ order_id: string | null; shipment_id: string; entry_id: string }[]>`
    select distinct o.id as order_id, l.shipment_id::text, l.entry_id
    from ledger_lines l
    join shipments s on s.id = l.shipment_id
    left join orders o on o.id = s.order_id
    where l.origin_type in ('shipment_sale', 'shipment_cogs') and l.account_code in ('4000', '5000') ${ledgerWhere(db, f)}
      and ${
        key === 'no_lines'
          ? db`not exists (select 1 from order_lines ol where ol.order_id = o.id and ol.qty > 0)`
          : key === 'unmapped'
            ? db`exists (select 1 from order_lines ol where ol.order_id = o.id and ol.qty > 0 and ol.variant_id is null)`
            : db`exists (select 1 from order_lines ol where ol.order_id = o.id and ol.qty > 0 and ol.variant_id = ${key})`
      }
    order by l.entry_id
  `;
  const unique = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => x !== null))];
  return { orderIds: unique(rows.map((r) => r.order_id)), shipmentIds: unique(rows.map((r) => r.shipment_id)), entryIds: unique(rows.map((r) => r.entry_id)) };
};
