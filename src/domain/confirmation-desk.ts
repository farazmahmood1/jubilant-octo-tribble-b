import { deskSettings, recomputeConfirmation } from '../db/repos/confirmations.js';
import { recomputeOrderState } from '../db/repos/order-state.js';
import { type Db, atomically, readPaisa } from '../db/repos/upsert.js';
import { normalizePk } from '../lib/phone.js';
import { endOfKarachiDay, startOfKarachiDate } from '../lib/time.js';
import {
  type AttemptOutcome,
  type Channel,
  type DerivedConfirmation,
  type DeskSettings,
  callLink,
  formatRupees,
  refusal,
  renderTemplate,
  whatsappLink,
} from './confirmation.js';
import type { ConfirmationState, OrderState } from './order-state.js';

/**
 * The Confirmation Desk's operations (Step 11): recording what happened when an agent contacted a
 * customer, the queue they work from, the customer's history by phone across both brands, and
 * how each agent is doing. Rules live in `confirmation.ts`; this file is their storage.
 */

export class DeskError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409 = 409) {
    super(message);
    this.name = 'DeskError';
    this.status = status;
  }
}

export interface AttemptInput {
  orderId: string;
  agentId: string;
  /** Null only for `rescheduled`: a follow-up set without contacting the customer. */
  channel: Channel | null;
  outcome: AttemptOutcome;
  /** When it happened: the caller's clock, so tests can control it. */
  at: Date;
  followUpAt?: Date | null;
  /** Required for a cancellation (why) and a change (what changed). */
  reason?: string | null;
  note?: string | null;
}

export interface AttemptResult {
  attemptId: string;
  confirmation: DerivedConfirmation;
  orderState: OrderState;
}

/**
 * Records one attempt, recomputes the confirmation and the order state from it, and audits it
 * with the agent (rule 8). Refused, writing nothing, when the outcome makes no sense for the
 * order as it stands.
 */
export const recordAttempt = async (db: Db, input: AttemptInput): Promise<AttemptResult> =>
  atomically(db, async (tx) => {
    const [order] = await tx<{ channel: string; cancelled_at: Date | null; placed_at: Date; booked: boolean }[]>`
      select channel, cancelled_at, placed_at, exists (select 1 from shipments s where s.order_id = o.id) as booked
      from orders o where id = ${input.orderId} for update
    `;
    if (!order) throw new DeskError(`Order ${input.orderId} not found`, 404);
    if (order.channel !== 'online') throw new DeskError(`A ${order.channel} order is not confirmed by the desk`);
    if (order.cancelled_at) throw new DeskError('The order is cancelled in Shopify');
    if (input.at.getTime() < order.placed_at.getTime()) throw new DeskError('An attempt cannot be dated before the order was placed');

    const rescheduling = input.outcome === 'rescheduled';
    if (rescheduling !== (input.channel === null)) {
      throw new DeskError(rescheduling ? 'A follow-up scheduled without contact has no channel' : 'Say whether the customer was contacted on WhatsApp or by call');
    }
    const followUp = input.followUpAt ?? null;
    if ((input.outcome === 'callback' || rescheduling) !== (followUp !== null)) {
      throw new DeskError(followUp ? 'Only a callback or a follow-up takes a time' : 'A callback or a follow-up needs a time');
    }
    if (followUp && followUp.getTime() <= input.at.getTime()) throw new DeskError('The follow-up time must be in the future');
    const reason = input.reason?.trim() || null;
    if ((input.outcome === 'cancelled' || input.outcome === 'changed') && !reason) {
      throw new DeskError(input.outcome === 'cancelled' ? 'Say why the customer cancelled' : 'Say what the customer changed');
    }

    const before = (await recomputeConfirmation(tx, input.orderId))!;
    const refused = refusal(before.state, input.outcome, order.booked);
    if (refused) throw new DeskError(refused);

    const [confirmation] = await tx<{ id: string }[]>`select id from confirmations where order_id = ${input.orderId}`;
    const [attempt] = await tx<{ id: string }[]>`
      insert into confirmation_attempts (confirmation_id, agent_id, channel, at, outcome, follow_up_at, reason, note)
      values (${confirmation!.id}, ${input.agentId}, ${input.channel}, ${input.at}, ${input.outcome}, ${followUp}, ${reason}, ${input.note?.trim() || null})
      returning id
    `;
    const after = (await recomputeConfirmation(tx, input.orderId))!;
    const state = await recomputeOrderState(tx, input.orderId);
    await tx`
      insert into audit_log (actor_id, action, entity, entity_id, before, after)
      values (${input.agentId}, ${`confirmation.${input.outcome}`}, 'orders', ${input.orderId},
              ${tx.json({ state: before.state, attempts: before.attempts })},
              ${tx.json({
                attemptId: attempt!.id,
                channel: input.channel,
                state: after.state,
                attempts: after.attempts,
                nextAttemptAt: after.nextAttemptAt?.toISOString() ?? null,
                reason,
              })})
    `;
    return { attemptId: attempt!.id, confirmation: after, orderState: state.to };
  });

// ---- The queue ----

export const QUEUE_STATES = ['pending', 'no_answer', 'unreachable', 'confirmed', 'changed', 'cancelled'] as const;

export interface QueueFilter {
  store?: 'nur' | 'organics';
  /** Default: the open ones, pending and no answer. */
  states?: ConfirmationState[];
  /** Only what is due at `now`. */
  dueOnly?: boolean;
  /** An order number, or a phone number in any shape the customer typed it. */
  search?: string;
  page: number;
  pageSize: number;
  now: Date;
}

export interface QueueRow {
  orderId: string;
  store: string;
  orderNumber: string;
  placedAt: Date;
  totalPaisa: string;
  items: string;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  state: ConfirmationState;
  source: DerivedConfirmation['source'];
  attempts: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  outcomeReason: string | null;
  agent: string | null;
  due: boolean;
  /** The customer's other orders, both brands, by phone. */
  history: { delivered: number; returned: number };
  whatsappUrl: string | null;
  callUrl: string | null;
}

interface ContactFacts {
  store: string;
  store_label: string;
  order_number: string;
  total: string;
  items: string | null;
  customer_name: string | null;
  phone: string | null;
  city: string | null;
}

/** The click-to-chat and call links for an order, from the brand's template. */
export const contactLinks = (o: ContactFacts, settings: DeskSettings): { whatsappUrl: string | null; callUrl: string | null } => {
  if (!o.phone) return { whatsappUrl: null, callUrl: null };
  const name = o.customer_name?.trim() || 'there';
  const template = o.store === 'organics' ? settings.whatsappTemplates.organics : settings.whatsappTemplates.nur;
  const message = renderTemplate(template, {
    name,
    firstName: name.split(/\s+/)[0]!,
    orderNumber: o.order_number,
    total: formatRupees(readPaisa(o.total)),
    items: o.items ?? 'your items',
    city: o.city ?? 'your city',
    store: o.store_label,
  });
  return { whatsappUrl: whatsappLink(o.phone, message), callUrl: callLink(o.phone) };
};

/** Orders the desk has not finished with: online, not cancelled in Shopify, not booked with PostEx. */
export const deskQueue = async (db: Db, f: QueueFilter): Promise<{ rows: QueueRow[]; total: number }> => {
  const states = f.states && f.states.length > 0 ? f.states : ['pending', 'no_answer'];
  const phone = f.search ? normalizePk(f.search) : null;
  const like = f.search ? `%${f.search.trim().replace(/[%_\\]/g, '\\$&')}%` : null;
  const rows = await db<
    (ContactFacts & {
      order_id: string; placed_at: Date; state: ConfirmationState; source: DerivedConfirmation['source']; attempts: number;
      next_attempt_at: Date | null; last_attempt_at: Date | null; outcome_reason: string | null; agent: string | null;
      delivered: number; returned: number; total_rows: number;
    })[]
  >`
    select o.id as order_id, st.key as store, st.label as store_label, o.order_number, o.placed_at, o.total_paisa::text as total,
           (select string_agg(ol.qty || ' × ' || ol.title, ', ' order by ol.id) from order_lines ol where ol.order_id = o.id and ol.qty > 0) as items,
           cu.name as customer_name, cu.phone_e164 as phone, ad.city,
           c.state, c.source, c.attempts, c.next_attempt_at, c.last_attempt_at, c.outcome_reason, u.name as agent,
           coalesce(h.delivered, 0) as delivered, coalesce(h.returned, 0) as returned,
           count(*) over ()::int as total_rows
    from confirmations c
    join orders o on o.id = c.order_id
    join stores st on st.id = o.store_id
    left join customers cu on cu.id = o.customer_id
    left join addresses ad on ad.id = o.shipping_address_id
    left join users u on u.id = c.agent_id
    left join lateral (
      select count(*) filter (where o2.state = 'delivered')::int as delivered,
             count(*) filter (where o2.state in ('returning', 'returned_received'))::int as returned
      from customers c2 join orders o2 on o2.customer_id = c2.id
      where cu.phone_e164 is not null and c2.phone_e164 = cu.phone_e164 and o2.id <> o.id
    ) h on true
    where o.channel = 'online' and o.cancelled_at is null
      and not exists (select 1 from shipments s where s.order_id = o.id)
      and c.state = any(${states}::text[])
      ${f.store ? db`and st.key = ${f.store}` : db``}
      ${f.dueOnly ? db`and (c.next_attempt_at is null or c.next_attempt_at <= ${f.now})` : db``}
      ${f.search ? db`and (o.order_number ilike ${like} ${phone ? db`or cu.phone_e164 = ${phone}` : db``})` : db``}
    order by c.next_attempt_at asc nulls first, o.placed_at, o.id
    limit ${f.pageSize} offset ${(f.page - 1) * f.pageSize}
  `;
  const settings = await deskSettings(db);
  return {
    total: rows[0]?.total_rows ?? 0,
    rows: rows.map((r) => ({
      orderId: r.order_id,
      store: r.store,
      orderNumber: r.order_number,
      placedAt: r.placed_at,
      totalPaisa: r.total,
      items: r.items ?? '',
      customerName: r.customer_name,
      phone: r.phone,
      city: r.city,
      state: r.state,
      source: r.source,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      lastAttemptAt: r.last_attempt_at,
      outcomeReason: r.outcome_reason,
      agent: r.agent,
      due: r.next_attempt_at === null || r.next_attempt_at.getTime() <= f.now.getTime(),
      history: { delivered: r.delivered, returned: r.returned },
      ...contactLinks(r, settings),
    })),
  };
};

// ---- One order at the desk ----

export interface DeskOrder {
  orderId: string;
  store: string;
  orderNumber: string;
  placedAt: Date;
  totalPaisa: string;
  state: OrderState | null;
  cancelledInShopify: boolean;
  booked: boolean;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  lines: Array<{ title: string; sku: string | null; qty: number; totalPaisa: string }>;
  confirmation: { state: ConfirmationState; source: string; attempts: number; nextAttemptAt: Date | null; outcomeReason: string | null; confirmedAt: Date | null } | null;
  attempts: Array<{ id: string; at: Date; agent: string; channel: Channel | null; outcome: AttemptOutcome; followUpAt: Date | null; reason: string | null; note: string | null }>;
  whatsappUrl: string | null;
  callUrl: string | null;
}

export const deskOrder = async (db: Db, orderId: string): Promise<DeskOrder | null> => {
  const [o] = await db<
    (ContactFacts & { placed_at: Date; state: OrderState | null; cancelled_at: Date | null; booked: boolean; channel: string })[]
  >`
    select st.key as store, st.label as store_label, o.order_number, o.placed_at, o.total_paisa::text as total, o.state, o.cancelled_at, o.channel,
           exists (select 1 from shipments s where s.order_id = o.id) as booked,
           (select string_agg(ol.qty || ' × ' || ol.title, ', ' order by ol.id) from order_lines ol where ol.order_id = o.id and ol.qty > 0) as items,
           cu.name as customer_name, cu.phone_e164 as phone, ad.city
    from orders o join stores st on st.id = o.store_id
    left join customers cu on cu.id = o.customer_id
    left join addresses ad on ad.id = o.shipping_address_id
    where o.id = ${orderId}
  `;
  if (!o) return null;
  const lines = await db<{ title: string; sku: string | null; qty: number; total: string }[]>`
    select title, sku, qty, total_paisa::text as total from order_lines where order_id = ${orderId} and qty > 0 order by id
  `;
  const [c] = await db<{ state: ConfirmationState; source: string; attempts: number; next_attempt_at: Date | null; outcome_reason: string | null; confirmed_at: Date | null }[]>`
    select state, source, attempts, next_attempt_at, outcome_reason, confirmed_at from confirmations where order_id = ${orderId}
  `;
  const attempts = await db<{ id: string; at: Date; agent: string; channel: Channel | null; outcome: AttemptOutcome; follow_up_at: Date | null; reason: string | null; note: string | null }[]>`
    select a.id, a.at, u.name as agent, a.channel, a.outcome, a.follow_up_at, a.reason, a.note
    from confirmation_attempts a join confirmations c on c.id = a.confirmation_id join users u on u.id = a.agent_id
    where c.order_id = ${orderId} order by a.at desc, a.id desc
  `;
  return {
    orderId,
    store: o.store,
    orderNumber: o.order_number,
    placedAt: o.placed_at,
    totalPaisa: o.total,
    state: o.state,
    cancelledInShopify: o.cancelled_at !== null,
    booked: o.booked,
    customerName: o.customer_name,
    phone: o.phone,
    city: o.city,
    lines: lines.map((l) => ({ title: l.title, sku: l.sku, qty: l.qty, totalPaisa: l.total })),
    confirmation: c
      ? { state: c.state, source: c.source, attempts: c.attempts, nextAttemptAt: c.next_attempt_at, outcomeReason: c.outcome_reason, confirmedAt: c.confirmed_at }
      : null,
    attempts: attempts.map((a) => ({ id: a.id, at: a.at, agent: a.agent, channel: a.channel, outcome: a.outcome, followUpAt: a.follow_up_at, reason: a.reason, note: a.note })),
    ...contactLinks(o, await deskSettings(db)),
  };
};

// ---- Customer history ----

export interface CustomerHistory {
  phone: string;
  orders: Array<{ orderId: string; store: string; orderNumber: string; placedAt: Date; totalPaisa: string; state: OrderState | null; channel: string; city: string | null }>;
  counts: {
    orders: number;
    delivered: number;
    /** Sent back to us: refused at the door, or returned after delivery. */
    refused: number;
    cancelled: number;
    /** Booked and not settled yet. */
    inFlight: number;
    /** Placed or confirmed, not booked yet. */
    awaiting: number;
  };
  /** Delivered out of delivered and refused; null with no outcome yet. */
  deliveryRate: number | null;
  /** Parcels to the city, both brands: how many came back. PR packages are left out. */
  city: { name: string; delivered: number; returned: number; returnRate: number | null } | null;
}

const IN_FLIGHT: readonly OrderState[] = ['booked', 'in_transit', 'failed'];
const AWAITING: readonly OrderState[] = ['placed', 'confirmed', 'ready_to_book'];

/**
 * Every order placed with a phone number, on either brand: the history lookup keys on
 * `customers.phone_e164`, the normalised `+92…` number (1.9), so a guest who typed the number
 * differently on each order is still one customer. `city` is the city to rate, usually the
 * order being confirmed; `excludeOrderId` leaves that order out of the counts.
 */
export const customerHistory = async (db: Db, rawPhone: string, opts: { city?: string | null; excludeOrderId?: string } = {}): Promise<CustomerHistory | null> => {
  const phone = normalizePk(rawPhone);
  if (!phone) return null;
  const orders = await db<{ order_id: string; store: string; order_number: string; placed_at: Date; total: string; state: OrderState | null; channel: string; city: string | null }[]>`
    select o.id as order_id, st.key as store, o.order_number, o.placed_at, o.total_paisa::text as total, o.state, o.channel, ad.city
    from customers c
    join orders o on o.customer_id = c.id
    join stores st on st.id = o.store_id
    left join addresses ad on ad.id = o.shipping_address_id
    where c.phone_e164 = ${phone} ${opts.excludeOrderId ? db`and o.id <> ${opts.excludeOrderId}` : db``}
    order by o.placed_at desc, o.id desc
    limit 200
  `;
  const count = (states: readonly (OrderState | null)[]) => orders.filter((o) => o.channel === 'online' && states.includes(o.state)).length;
  const delivered = count(['delivered']);
  const refused = count(['returning', 'returned_received']);
  let city: CustomerHistory['city'] = null;
  if (opts.city?.trim()) {
    const [row] = await db<{ delivered: number; returned: number }[]>`
      select count(*) filter (where o.state = 'delivered')::int as delivered,
             count(*) filter (where o.state in ('returning', 'returned_received'))::int as returned
      from addresses ad join orders o on o.shipping_address_id = ad.id
      where lower(trim(ad.city)) = lower(trim(${opts.city})) and ad.city is not null and o.channel = 'online'
    `;
    const settled = row!.delivered + row!.returned;
    city = { name: opts.city.trim(), delivered: row!.delivered, returned: row!.returned, returnRate: settled === 0 ? null : row!.returned / settled };
  }
  return {
    phone,
    orders: orders.map((o) => ({ orderId: o.order_id, store: o.store, orderNumber: o.order_number, placedAt: o.placed_at, totalPaisa: o.total, state: o.state, channel: o.channel, city: o.city })),
    counts: {
      orders: orders.length,
      delivered,
      refused,
      cancelled: count(['cancelled']),
      inFlight: count(IN_FLIGHT),
      awaiting: count(AWAITING),
    },
    deliveryRate: delivered + refused === 0 ? null : delivered / (delivered + refused),
    city,
  };
};

// ---- Agent performance ----

export interface AgentPerformance {
  agentId: string;
  name: string;
  /** Customers contacted: every attempt except a follow-up scheduled without contact. */
  contacts: number;
  ordersWorked: number;
  confirmed: number;
  changed: number;
  cancelled: number;
  noAnswer: number;
  wrongNumber: number;
  callbacks: number;
  /** Orders now unreachable whose last attempt was theirs. */
  unreachable: number;
  /** Confirmed or changed, out of every order they brought to a decision or to unreachable. */
  confirmationRate: number | null;
  /** Median minutes from an order being placed to their first contact, where theirs was the first. */
  medianMinutesToFirstContact: number | null;
  /** What happened to the parcels of the orders they confirmed: the quality of a confirmation. */
  outcomes: { delivered: number; returned: number; returnRate: number | null };
}

export const agentPerformance = async (db: Db, f: { from?: string; to?: string } = {}): Promise<AgentPerformance[]> => {
  const from = f.from ? startOfKarachiDate(f.from) : new Date(0);
  const to = f.to ? endOfKarachiDay(f.to) : new Date('9999-12-31T00:00:00Z');
  const rows = await db<
    {
      agent_id: string; name: string; contacts: number; orders_worked: number; confirmed: number; changed: number; cancelled: number;
      no_answer: number; wrong_number: number; callbacks: number; unreachable: number; median_minutes: number | null; delivered: number; returned: number;
    }[]
  >`
    with period as (
      select * from confirmation_attempts where at between ${from} and ${to}
    ),
    per_agent as (
      select agent_id,
             count(*) filter (where outcome <> 'rescheduled')::int as contacts,
             count(distinct confirmation_id)::int as orders_worked,
             count(*) filter (where outcome = 'confirmed')::int as confirmed,
             count(*) filter (where outcome = 'changed')::int as changed,
             count(*) filter (where outcome = 'cancelled')::int as cancelled,
             count(*) filter (where outcome = 'no_answer')::int as no_answer,
             count(*) filter (where outcome = 'wrong_number')::int as wrong_number,
             count(*) filter (where outcome = 'callback')::int as callbacks
      from period group by agent_id
    ),
    unreachable as (
      select agent_id, count(*)::int as n from confirmations
      where state = 'unreachable' and source = 'desk' and last_attempt_at between ${from} and ${to}
      group by agent_id
    ),
    first_contact as (
      select distinct on (a.confirmation_id) a.agent_id, a.at, o.placed_at
      from confirmation_attempts a join confirmations c on c.id = a.confirmation_id join orders o on o.id = c.order_id
      where a.outcome <> 'rescheduled'
      order by a.confirmation_id, a.at, a.id
    ),
    speed as (
      select agent_id, round(percentile_cont(0.5) within group (order by extract(epoch from at - placed_at) / 60))::int as median_minutes
      from first_contact where at between ${from} and ${to} group by agent_id
    ),
    confirmer as (
      select distinct on (c.id) a.agent_id, o.state
      from confirmations c
      join confirmation_attempts a on a.confirmation_id = c.id and a.outcome in ('confirmed', 'changed')
      join orders o on o.id = c.order_id
      where c.state in ('confirmed', 'changed') and a.at between ${from} and ${to}
      order by c.id, a.at desc, a.id desc
    ),
    quality as (
      select agent_id,
             count(*) filter (where state = 'delivered')::int as delivered,
             count(*) filter (where state in ('returning', 'returned_received'))::int as returned
      from confirmer group by agent_id
    )
    select p.agent_id, u.name, p.contacts, p.orders_worked, p.confirmed, p.changed, p.cancelled, p.no_answer, p.wrong_number, p.callbacks,
           coalesce(un.n, 0) as unreachable, s.median_minutes, coalesce(q.delivered, 0) as delivered, coalesce(q.returned, 0) as returned
    from per_agent p
    join users u on u.id = p.agent_id
    left join unreachable un on un.agent_id = p.agent_id
    left join speed s on s.agent_id = p.agent_id
    left join quality q on q.agent_id = p.agent_id
    order by p.contacts desc, u.name
  `;
  return rows.map((r) => {
    const decided = r.confirmed + r.changed + r.cancelled + r.unreachable;
    const settled = r.delivered + r.returned;
    return {
      agentId: r.agent_id,
      name: r.name,
      contacts: r.contacts,
      ordersWorked: r.orders_worked,
      confirmed: r.confirmed,
      changed: r.changed,
      cancelled: r.cancelled,
      noAnswer: r.no_answer,
      wrongNumber: r.wrong_number,
      callbacks: r.callbacks,
      unreachable: r.unreachable,
      confirmationRate: decided === 0 ? null : (r.confirmed + r.changed) / decided,
      medianMinutesToFirstContact: r.median_minutes,
      outcomes: { delivered: r.delivered, returned: r.returned, returnRate: settled === 0 ? null : r.returned / settled },
    };
  });
};
