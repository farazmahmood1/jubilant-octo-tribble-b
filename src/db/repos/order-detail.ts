import { SETTLED, orderProfits } from '../../reports/recent-orders.js';
import { DAYS_SQL, STAGE_SQL, type Stage } from './parcels.js';
import type { Db } from './upsert.js';

/**
 * One order, in full: what the list shows and what it leaves out. The state is read as the
 * recompute wrote it (rule 7), never derived again here. Nothing here writes.
 *
 * What a caller may see is decided by the caller, through `options`, so the route is the only place
 * that knows about roles: the street address and phone are customers' contact details, and the
 * PostEx charges, payouts and profit are the books.
 */
export interface OrderDetail {
  id: string;
  orderNumber: string;
  store: 'nur' | 'organics';
  channel: 'online' | 'consignment' | 'pr';
  /** Where the row came from: the Shopify API, a CSV import, or a partner's sales sheet. */
  source: string;
  state: string | null;
  placedAt: Date;
  cancelledAt: Date | null;
  cancelReason: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  tags: string[];
  discountCodes: string[];
  influencer: { name: string; handle: string } | null;
  money: { subtotalPaisa: string; discountPaisa: string; shippingPaisa: string; taxPaisa: string; totalPaisa: string };
  customer: {
    name: string | null;
    phone: string | null;
    address: { line1: string | null; line2: string | null; city: string | null; province: string | null; postal: string | null; country: string | null } | null;
  };
  lines: Array<{ title: string; sku: string | null; qty: number; unitPaisa: string; discountPaisa: string; totalPaisa: string }>;
  confirmation: {
    state: string;
    source: string;
    attempts: number;
    agent: string | null;
    confirmedAt: Date | null;
    lastAttemptAt: Date | null;
    nextAttemptAt: Date | null;
    outcomeReason: string | null;
  } | null;
  attempts: Array<{ at: Date; agent: string; channel: string | null; outcome: string; followUpAt: Date | null; reason: string | null; note: string | null }>;
  parcels: Array<{
    id: string;
    trackingNumber: string;
    stage: Stage;
    statusLabel: string | null;
    statusMessage: string | null;
    bookedAt: Date | null;
    deliveredAt: Date | null;
    codPaisa: string | null;
    attempts: number;
    lastFailureReason: string | null;
    daysInTransit: number | null;
    /** Null unless the caller may see the books. */
    charges: Array<{ kind: string; amountPaisa: string }> | null;
    payouts: Array<{ cprNumber: string; paidAt: Date | null; amountPaisa: string }> | null;
  }>;
  /** Every change of state with the reason, oldest first. */
  history: Array<{ at: Date; from: string | null; to: string; cause: string }>;
  openItems: Array<{ id: string; kind: string; severity: string; detail: Record<string, unknown> }>;
  /** Whether the caller may see the books, so a missing profit can be told from one not yet made. */
  books: boolean;
  /** Null until the order is delivered or returned, and for a caller who may not see the books. */
  profitPaisa: string | null;
}

export interface OrderDetailOptions {
  /** May see the phone number and the street address. */
  contact: boolean;
  /** May see PostEx charges, payouts and the order's profit. */
  books: boolean;
}

export const orderDetail = async (db: Db, id: string, options: OrderDetailOptions): Promise<OrderDetail | null> => {
  const [o] = await db<
    {
      id: string; order_number: string; store: 'nur' | 'organics'; channel: OrderDetail['channel']; source: string; state: string | null; placed_at: Date;
      cancelled_at: Date | null; cancel_reason: string | null; financial_status: string | null; fulfillment_status: string | null; tags: string[];
      discount_codes: string[]; subtotal: string; discount: string; shipping: string; tax: string; total: string; customer_name: string | null;
      phone: string | null; line1: string | null; line2: string | null; city: string | null; province: string | null; postal: string | null;
      country: string | null; has_address: boolean; influencer_name: string | null; influencer_handle: string | null;
    }[]
  >`
    select o.id::text, o.order_number, st.key as store, o.channel, o.source, o.state, o.placed_at, o.cancelled_at, o.cancel_reason,
           o.financial_status, o.fulfillment_status, o.tags, o.discount_codes,
           o.subtotal_paisa::text as subtotal, o.discount_paisa::text as discount, o.shipping_paisa::text as shipping, o.tax_paisa::text as tax, o.total_paisa::text as total,
           c.name as customer_name, c.phone_e164 as phone, ad.id is not null as has_address,
           ad.line1, ad.line2, ad.city, ad.province, ad.postal, ad.country,
           inf.name as influencer_name, inf.handle as influencer_handle
    from orders o
    join stores st on st.id = o.store_id
    left join customers c on c.id = o.customer_id
    left join addresses ad on ad.id = o.shipping_address_id
    left join lateral (
      -- The first of the order's codes that is an influencer's in this store, as the breakdown report attributes it.
      select i.name, i.handle
      from unnest(o.discount_codes) with ordinality as used (code, n)
      join influencer_codes ic on ic.store_id = o.store_id and lower(ic.discount_code) = lower(used.code)
      join influencers i on i.id = ic.influencer_id
      order by used.n limit 1
    ) inf on true
    where o.id = ${id}
  `;
  if (!o) return null;

  const lines = await db<{ title: string; sku: string | null; qty: number; unit: string; discount: string; total: string }[]>`
    select title, sku, qty, unit_price_paisa::text as unit, discount_paisa::text as discount, total_paisa::text as total
    from order_lines where order_id = ${id} and qty > 0 order by id
  `;

  const [cf] = await db<
    {
      id: string; state: string; source: string; attempts: number; agent: string | null; confirmed_at: Date | null; last_attempt_at: Date | null;
      next_attempt_at: Date | null; outcome_reason: string | null;
    }[]
  >`
    select c.id::text, c.state, c.source, c.attempts, u.name as agent, c.confirmed_at, c.last_attempt_at, c.next_attempt_at, c.outcome_reason
    from confirmations c left join users u on u.id = c.agent_id where c.order_id = ${id}
  `;
  const attempts = cf
    ? await db<{ at: Date; agent: string; channel: string | null; outcome: string; follow_up_at: Date | null; reason: string | null; note: string | null }[]>`
        select a.at, u.name as agent, a.channel, a.outcome, a.follow_up_at, a.reason, a.note
        from confirmation_attempts a join users u on u.id = a.agent_id where a.confirmation_id = ${cf.id} order by a.at desc, a.id desc
      `
    : [];

  const shipments = await db<
    {
      id: string; tracking_number: string; stage: Stage; status_label: string | null; status_message: string | null; booked_at: Date | null; delivered_at: Date | null;
      cod: string | null; attempts_count: number; last_failure_reason: string | null; days: number | null;
    }[]
  >`
    select s.id::text, s.tracking_number, ${db.unsafe(STAGE_SQL)} as stage, s.status_label, s.status_message, s.booked_at, s.delivered_at,
           s.cod_amount_paisa::text as cod, s.attempts_count, s.last_failure_reason, ${db.unsafe(DAYS_SQL)} as days
    from shipments s where s.order_id = ${id} order by s.booked_at nulls last, s.id
  `;
  const ids = shipments.map((s) => s.id);
  const charges = options.books && ids.length > 0
    ? await db<{ shipment_id: string; kind: string; amount: string }[]>`
        select shipment_id::text, kind, amount_paisa::text as amount from shipment_charges where shipment_id = any(${ids}::bigint[]) order by kind
      `
    : [];
  const payouts = options.books && ids.length > 0
    ? await db<{ shipment_id: string; cpr_number: string; paid_at: Date | null; amount: string }[]>`
        select l.shipment_id::text, p.cpr_number, p.paid_at, l.amount_paisa::text as amount
        from payout_lines l join cod_payouts p on p.id = l.cod_payout_id where l.shipment_id = any(${ids}::bigint[]) order by p.paid_at
      `
    : [];

  const history = await db<{ at: Date; from_state: string | null; to_state: string; cause: string }[]>`
    select at, from_state, to_state, cause from order_state_log where order_id = ${id} order by at, id
  `;
  const items = await db<{ id: string; kind: string; severity: string; detail: Record<string, unknown> }[]>`
    select id::text, kind, severity, detail from reconciliation_items
    where status = 'open' and (order_id = ${id} ${ids.length > 0 ? db`or shipment_id = any(${ids}::bigint[])` : db``}) order by created_at
  `;
  const profit = options.books && o.state && SETTLED.includes(o.state) ? (await orderProfits(db, [id])).get(id) ?? null : null;

  return {
    id: o.id,
    orderNumber: o.order_number,
    store: o.store,
    channel: o.channel,
    source: o.source,
    state: o.state,
    placedAt: o.placed_at,
    cancelledAt: o.cancelled_at,
    cancelReason: o.cancel_reason,
    financialStatus: o.financial_status,
    fulfillmentStatus: o.fulfillment_status,
    tags: o.tags,
    discountCodes: o.discount_codes,
    influencer: o.influencer_name && o.influencer_handle ? { name: o.influencer_name, handle: o.influencer_handle } : null,
    money: { subtotalPaisa: o.subtotal, discountPaisa: o.discount, shippingPaisa: o.shipping, taxPaisa: o.tax, totalPaisa: o.total },
    customer: {
      name: o.customer_name,
      phone: options.contact ? o.phone : null,
      address: o.has_address
        ? {
            // The city and province say where, and drive the reports; the street is a contact detail.
            line1: options.contact ? o.line1 : null,
            line2: options.contact ? o.line2 : null,
            city: o.city,
            province: o.province,
            postal: options.contact ? o.postal : null,
            country: o.country,
          }
        : null,
    },
    lines: lines.map((l) => ({ title: l.title, sku: l.sku, qty: l.qty, unitPaisa: l.unit, discountPaisa: l.discount, totalPaisa: l.total })),
    confirmation: cf
      ? {
          state: cf.state,
          source: cf.source,
          attempts: cf.attempts,
          agent: cf.agent,
          confirmedAt: cf.confirmed_at,
          lastAttemptAt: cf.last_attempt_at,
          nextAttemptAt: cf.next_attempt_at,
          outcomeReason: cf.outcome_reason,
        }
      : null,
    attempts: attempts.map((a) => ({ at: a.at, agent: a.agent, channel: a.channel, outcome: a.outcome, followUpAt: a.follow_up_at, reason: a.reason, note: a.note })),
    parcels: shipments.map((s) => ({
      id: s.id,
      trackingNumber: s.tracking_number,
      stage: s.stage,
      statusLabel: s.status_label,
      statusMessage: s.status_message,
      bookedAt: s.booked_at,
      deliveredAt: s.delivered_at,
      codPaisa: s.cod,
      attempts: s.attempts_count,
      lastFailureReason: s.last_failure_reason,
      daysInTransit: s.days,
      charges: options.books ? charges.filter((c) => c.shipment_id === s.id).map((c) => ({ kind: c.kind, amountPaisa: c.amount })) : null,
      payouts: options.books ? payouts.filter((p) => p.shipment_id === s.id).map((p) => ({ cprNumber: p.cpr_number, paidAt: p.paid_at, amountPaisa: p.amount })) : null,
    })),
    history: history.map((h) => ({ at: h.at, from: h.from_state, to: h.to_state, cause: h.cause })),
    openItems: items.map((i) => ({ id: i.id, kind: i.kind, severity: i.severity, detail: i.detail })),
    books: options.books,
    profitPaisa: profit,
  };
};
