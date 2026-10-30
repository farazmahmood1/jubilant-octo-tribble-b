import { createHash } from 'node:crypto';

import type { Sql } from '../db.js';
import { type Db, atomically } from '../db/repos/upsert.js';
import { shopifyClient } from '../integrations/shopify/client.js';
import { logger } from '../logger.js';

/**
 * A return check-in, carried through to Shopify, so the store's stock says what the shelf says.
 *
 * Restocking and cancelling are two different things and are never done together. Checking a
 * parcel in (Restock, Damaged, or split) only ever adds units back to Shopify's available stock,
 * and only units Shopify itself counts as gone. Cancelling the Shopify order is a separate action a
 * person chooses (`cancelShopifyOrderForReturn`), never a side effect.
 *
 * What Shopify needs is worked out per product, for the whole order, from Shopify's own record read
 * live at the time (every parcel of the order counts, so a re-sent order is not restocked twice):
 *
 *   gone       = ordered − still committed − already restocked by Shopify
 *   add now    = min(units checked in as restocked, gone) − units the platform already added
 *
 * - **Still committed** are units on an order that is open and not fulfilled: Shopify still counts
 *   them on hand, just not available. Adding them would count them twice the moment the order is
 *   cancelled with restock, so they are left alone and the attempt is `pending` until the order is
 *   cancelled (here, as its own action, or in Shopify) or otherwise settled.
 * - **Already restocked by Shopify**: units put back when the order was cancelled with restock
 *   (refund line restock type CANCEL), refunded with restock, or restocked from a Shopify return.
 *   A cancelled order whose items were not restocked (NO_RESTOCK) counts them as gone, so they are
 *   added back.
 * - **Already added by the platform**: every adjustment this code made for the order, as recorded.
 *   Together with an idempotency key per order, product and running total, a retry, a double
 *   click, a re-check or two people at once can never add the same units twice. Attempts for one
 *   order are also serialised by a transaction-scoped advisory lock.
 *
 * Damaged units are never added. A Shopify failure is recorded as `failed` with Shopify's reason and
 * is never reported as done; what Shopify did accept before the failure is kept, so a retry does
 * only what is left. Every attempt is a row in `shopify_writebacks` (append-only).
 */

export type WritebackOutcome = 'done' | 'skipped' | 'failed' | 'pending';
/** `cancel_restock` and `write_off` are kept for attempts recorded before restock and cancel were separated. */
export type WritebackAction = 'restock' | 'cancel' | 'none' | 'cancel_restock' | 'write_off';

export interface ShopifyOrderLine {
  /** Numeric Shopify variant id; null for a custom line. */
  variantId: string | null;
  inventoryItemGid: string | null;
  quantity: number;
  /** Units still committed to the order: unfulfilled, on an order that is not cancelled. */
  committed: number;
  /** Units Shopify has already put back: on cancellation or refund with restock, or from a return. */
  restocked: number;
}

export interface ShopifyOrderFacts {
  name: string;
  cancelled: boolean;
  /** `displayFulfillmentStatus`: UNFULFILLED, FULFILLED, PARTIALLY_FULFILLED, RESTOCKED, … */
  fulfillment: string;
  /** Where a fulfilment was sent from, when there is one. */
  locationGid: string | null;
  lines: ShopifyOrderLine[];
}

export interface InventoryChange {
  inventoryItemGid: string;
  locationGid: string;
  delta: number;
}

/** The calls the write-back makes. The default calls the real stores; tests pass their own. */
export interface ShopifyReturnsGateway {
  order(store: string, shopifyOrderId: string): Promise<ShopifyOrderFacts | null>;
  cancel(store: string, shopifyOrderId: string, input: { staffNote: string; restock: boolean }): Promise<void>;
  adjust(store: string, input: { reason: 'restock' | 'damaged'; key: string; reference: string; changes: InventoryChange[] }): Promise<void>;
}

const userErrors = (errors: Array<{ message: string }> | undefined): void => {
  if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '));
};

interface OrderNode {
  name: string;
  cancelledAt: string | null;
  displayFulfillmentStatus: string;
  fulfillments: Array<{ location: { id: string } | null }>;
  lineItems: { nodes: Array<{ id: string; quantity: number; unfulfilledQuantity: number; variant: { id: string; inventoryItem: { id: string } | null } | null }> };
  refunds: Array<{ refundLineItems: { nodes: Array<{ quantity: number; restocked: boolean; restockType: string; lineItem: { id: string } | null }> } }>;
  returns: {
    nodes: Array<{
      reverseFulfillmentOrders: {
        nodes: Array<{ lineItems: { nodes: Array<{ fulfillmentLineItem: { lineItem: { id: string } | null } | null; dispositions: Array<{ type: string; quantity: number }> }> } }>;
      };
    }>;
  };
}

const ORDER_FACTS_QUERY = `
  query ReturnOrder($id: ID!) {
    order(id: $id) {
      name cancelledAt displayFulfillmentStatus
      fulfillments(first: 5) { location { id } }
      lineItems(first: 100) { nodes { id quantity unfulfilledQuantity variant { id inventoryItem { id } } } }
      refunds(first: 20) { refundLineItems(first: 100) { nodes { quantity restocked restockType lineItem { id } } } }
      returns(first: 10) { nodes { reverseFulfillmentOrders(first: 5) { nodes { lineItems(first: 50) { nodes { fulfillmentLineItem { lineItem { id } } dispositions { type quantity } } } } } } }
    }
  }
`;

const add = (map: Map<string, number>, key: string | undefined, n: number) => {
  if (key) map.set(key, (map.get(key) ?? 0) + n);
};

/**
 * Shopify's order as the write-back needs it: per line, what is still committed and what Shopify
 * already put back. A unit restocked from a return can show both as a restocked refund line (type
 * RETURN) and as a RESTOCKED disposition, so the disposition only counts beyond the refund lines.
 * A cancelled order keeps its `unfulfilledQuantity` (live data, Oct 2026), so it commits nothing.
 */
export const orderFactsFrom = (node: OrderNode): ShopifyOrderFacts => {
  const refunded = new Map<string, number>();
  const refundedOnReturn = new Map<string, number>();
  for (const refund of node.refunds) {
    for (const line of refund.refundLineItems.nodes) {
      if (!line.restocked) continue;
      add(refunded, line.lineItem?.id, line.quantity);
      if (line.restockType === 'RETURN') add(refundedOnReturn, line.lineItem?.id, line.quantity);
    }
  }
  const disposed = new Map<string, number>();
  for (const ret of node.returns.nodes) {
    for (const rfo of ret.reverseFulfillmentOrders.nodes) {
      for (const line of rfo.lineItems.nodes) {
        for (const d of line.dispositions) if (d.type === 'RESTOCKED') add(disposed, line.fulfillmentLineItem?.lineItem?.id, d.quantity);
      }
    }
  }
  const cancelled = node.cancelledAt !== null;
  return {
    name: node.name,
    cancelled,
    fulfillment: node.displayFulfillmentStatus,
    locationGid: node.fulfillments.find((f) => f.location)?.location?.id ?? null,
    lines: node.lineItems.nodes.map((line) => ({
      variantId: line.variant ? line.variant.id.replace('gid://shopify/ProductVariant/', '') : null,
      inventoryItemGid: line.variant?.inventoryItem?.id ?? null,
      quantity: line.quantity,
      committed: cancelled ? 0 : Math.max(0, line.unfulfilledQuantity),
      restocked: (refunded.get(line.id) ?? 0) + Math.max(0, (disposed.get(line.id) ?? 0) - (refundedOnReturn.get(line.id) ?? 0)),
    })),
  };
};

export const liveReturnsGateway: ShopifyReturnsGateway = {
  order: async (store, shopifyOrderId) => {
    const data = await shopifyClient(store).graphql<{ order: OrderNode | null }>(ORDER_FACTS_QUERY, { id: `gid://shopify/Order/${shopifyOrderId}` });
    return data.order ? orderFactsFrom(data.order) : null;
  },
  cancel: async (store, shopifyOrderId, input) => {
    const data = await shopifyClient(store).graphql<{ orderCancel: { orderCancelUserErrors: Array<{ message: string }> } }>(
      `mutation ReturnCancel($id: ID!, $restock: Boolean!, $note: String) {
        orderCancel(orderId: $id, reason: CUSTOMER, restock: $restock, notifyCustomer: false, staffNote: $note) { orderCancelUserErrors { field message code } }
      }`,
      { id: `gid://shopify/Order/${shopifyOrderId}`, restock: input.restock, note: input.staffNote.slice(0, 255) },
    );
    userErrors(data.orderCancel.orderCancelUserErrors);
  },
  adjust: async (store, input) => {
    const data = await shopifyClient(store).graphql<{ inventoryAdjustQuantities: { userErrors: Array<{ message: string }> } }>(
      `mutation ReturnAdjust($input: InventoryAdjustQuantitiesInput!, $key: String!) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { userErrors { field message } }
      }`,
      {
        key: input.key,
        input: {
          reason: input.reason,
          name: 'available',
          referenceDocumentUri: input.reference,
          changes: input.changes.map((c) => ({ delta: c.delta, inventoryItemId: c.inventoryItemGid, locationId: c.locationGid, changeFromQuantity: null })),
        },
      },
    );
    userErrors(data.inventoryAdjustQuantities.userErrors);
  },
};

/** One product's sums for an order, and what the write-back did or still needs for it. */
export interface WritebackProduct {
  /** Shopify variant id. */
  variant: string;
  title: string;
  /** Checked in on the shelf / damaged, over every parcel of the order. */
  restocked: number;
  damaged: number;
  /** Shopify's own figures for the order, as read for this attempt. */
  ordered: number;
  committed: number;
  restockedByShopify: number;
  /** Units the platform had already added back before this attempt, and adds in it. */
  addedBefore: number;
  addedNow: number;
  /** Returned units Shopify still holds as committed to the open order. */
  waiting: number;
  /** Units Shopify shows back in stock beyond what came back in good condition: restocked twice, or damaged units restocked. */
  ahead: number;
}

interface Applied {
  variant: string;
  delta: number;
  reason: 'restock' | 'damaged';
  key: string;
}

interface WritebackDetail {
  message?: string;
  order?: string | null;
  products?: WritebackProduct[];
  applied?: Applied[];
  /** Whether the order is open in Shopify with returned units committed to it, so a person may cancel it. */
  cancellable?: boolean;
  // Attempts recorded before restock and cancel were separated.
  steps?: string[];
  units?: Array<{ variant: string; qty: number }>;
}

export interface WritebackState {
  outcome: WritebackOutcome;
  action: WritebackAction;
  /** A sentence for the screen: what Shopify now shows, or why nothing was done. */
  message: string;
  error: string | null;
  at: Date;
  /** The order is still open in Shopify with returned units committed to it: cancelling it is offered. */
  cancellable: boolean;
  products: WritebackProduct[];
}

interface CheckInFacts {
  check_in_id: string;
  outcome: 'restocked' | 'damaged' | 'mixed';
  tracking_number: string;
  order_id: string | null;
  order_number: string | null;
  shopify_order_id: string | null;
  store: string | null;
  store_id: string | null;
}

const latestRow = async (db: Db, checkInId: string) => {
  const [row] = await db<{ outcome: WritebackOutcome; action: WritebackAction; detail: WritebackDetail; error: string | null; at: Date }[]>`
    select outcome, action, detail, error, at from shopify_writebacks where check_in_id = ${checkInId} order by at desc, id desc limit 1
  `;
  return row;
};

const stateOf = (row: { outcome: WritebackOutcome; action: WritebackAction; detail: WritebackDetail; error: string | null; at: Date }): WritebackState => ({
  outcome: row.outcome,
  action: row.action,
  message: row.detail.message ?? '',
  error: row.error,
  at: row.at,
  cancellable: row.detail.cancellable === true,
  products: row.detail.products ?? [],
});

/** Where one check-in stands in Shopify: its latest attempt, or null when none was made. */
export const writebackState = async (db: Db, checkInId: string): Promise<WritebackState | null> => {
  const row = await latestRow(db, checkInId);
  return row ? stateOf(row) : null;
};

/** Whether check-ins are carried to Shopify (`shopify` setting, on unless switched off). */
export const returnsWritebackEnabled = async (db: Db): Promise<boolean> => {
  const [row] = await db<{ value: { returnsWriteback?: boolean } }[]>`select value from app_settings where key = 'shopify'`;
  return row?.value.returnsWriteback !== false;
};

const friendly = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  // The network, not Shopify: nothing was refused, it can simply be tried again.
  if (/fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|Connect Timeout|socket hang up/i.test(text)) {
    return 'Shopify could not be reached just now. Nothing was changed there; press Retry later.';
  }
  if (/access denied|write_orders|write_inventory|scope/i.test(text)) {
    return `Shopify has not given the platform permission yet (the app needs write_orders and write_inventory): ${text}`;
  }
  return text;
};

/** A return action refused (409), or one Shopify did not carry out (502), with a sentence for the screen. */
export class ReturnsActionError extends Error {
  readonly status: 409 | 502;
  constructor(message: string, status: 409 | 502 = 409) {
    super(message);
    this.name = 'ReturnsActionError';
    this.status = status;
  }
}

const checkInFacts = async (db: Db, checkInId: string): Promise<CheckInFacts> => {
  const [facts] = await db<CheckInFacts[]>`
    select c.id as check_in_id, c.outcome, s.tracking_number, o.id as order_id, o.order_number, o.shopify_order_id::text, st.key as store, st.id as store_id
    from return_check_ins c
    join shipments s on s.id = c.shipment_id
    left join orders o on o.id = s.order_id
    left join stores st on st.id = o.store_id
    where c.id = ${checkInId}
  `;
  if (!facts) throw new ReturnsActionError(`Check-in ${checkInId} not found`);
  return facts;
};

const record = async (
  db: Db,
  facts: CheckInFacts,
  actorId: string | null,
  row: { outcome: WritebackOutcome; action: WritebackAction; message: string; detail?: Omit<WritebackDetail, 'message'>; error?: string | null },
): Promise<WritebackState> => {
  const detail: WritebackDetail = { order: facts.order_number, ...row.detail, message: row.message };
  const [inserted] = await db<{ at: Date }[]>`
    insert into shopify_writebacks (check_in_id, store_id, outcome, action, detail, error, actor_id)
    values (${facts.check_in_id}, ${facts.store_id}, ${row.outcome}, ${row.action}, ${db.json(detail as never)}, ${row.error ?? null}, ${actorId})
    returning at
  `;
  return stateOf({ outcome: row.outcome, action: row.action, detail, error: row.error ?? null, at: inserted!.at });
};

/** A re-check that found nothing new: no attempt row, only when it looked, so it is not asked again for a while. */
const unchanged = async (db: Db, checkInId: string, latest: Parameters<typeof stateOf>[0]): Promise<WritebackState> => {
  await db`
    insert into shopify_writeback_checks (check_in_id, checked_at) values (${checkInId}, now())
    on conflict (check_in_id) do update set checked_at = excluded.checked_at
  `;
  return stateOf(latest);
};

/** Serialises every Shopify write for one order, until the surrounding transaction ends. */
const lockOrder = async (tx: Db, orderId: string): Promise<void> => {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`nur.shopify-return:${orderId}`}, 0))`;
};

interface Ours {
  variant: string;
  title: string;
  restocked: number;
  damaged: number;
  locationGid: string | null;
}

/** What came back, per Shopify variant, over every checked-in parcel of the order, and where Shopify keeps it. */
const unitsOfOrder = async (db: Db, orderId: string): Promise<Ours[]> => {
  const rows = await db<{ variant: string; title: string; restocked: number; damaged: number; location_gid: string | null }[]>`
    select v.shopify_variant_id::text as variant, p.title || ' · ' || v.title as title,
           coalesce(sum(m.qty) filter (where l.key = 'warehouse'), 0)::int as restocked,
           coalesce(sum(m.qty) filter (where l.key = 'damaged'), 0)::int as damaged,
           (select sl.location_gid from shopify_stock_levels sl where sl.variant_id = v.id order by sl.on_hand desc limit 1) as location_gid
    from return_check_ins c
    join shipments s on s.id = c.shipment_id
    join stock_moves m on m.ref_type = 'return_check_in' and m.ref_id = c.id::text
    join locations l on l.id = m.to_location_id
    join variants v on v.id = m.variant_id
    join products p on p.id = v.product_id
    where s.order_id = ${orderId}
    group by v.id, v.shopify_variant_id, p.title, v.title
    order by v.shopify_variant_id
  `;
  return rows.map((r) => ({ variant: r.variant, title: r.title.replace(/ · Default Title$/, ''), restocked: r.restocked, damaged: r.damaged, locationGid: r.location_gid }));
};

/** Every adjustment the platform made in Shopify for the order, per variant, from every recorded attempt. */
const appliedForOrder = async (db: Db, orderId: string): Promise<Map<string, { restock: number; damaged: number }>> => {
  const rows = await db<{ detail: WritebackDetail }[]>`
    select w.detail from shopify_writebacks w
    join return_check_ins c on c.id = w.check_in_id
    join shipments s on s.id = c.shipment_id
    where s.order_id = ${orderId}
  `;
  const totals = new Map<string, { restock: number; damaged: number }>();
  const bump = (variant: string, reason: 'restock' | 'damaged', n: number) => {
    const t = totals.get(variant) ?? { restock: 0, damaged: 0 };
    t[reason] += n;
    totals.set(variant, t);
  };
  for (const { detail } of rows) {
    for (const a of detail.applied ?? []) bump(a.variant, a.reason, Math.abs(a.delta));
    // Before restock and cancel were separated, a successful step was recorded by name with the units.
    if (!detail.applied) {
      if (detail.steps?.includes('restock')) for (const u of detail.units ?? []) bump(u.variant, 'restock', u.qty);
      if (detail.steps?.includes('write_off')) for (const u of detail.units ?? []) bump(u.variant, 'damaged', u.qty);
    }
  }
  return totals;
};

const idempotencyKey = (parts: string): string => `nur-return-${createHash('sha256').update(parts).digest('hex').slice(0, 40)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Brings Shopify's available stock in line with an order's checked-in returns, and records the
 * attempt. Never cancels the order. Safe to call any number of times, at once or in a row: it only
 * ever adds what is still missing. Never throws for a Shopify refusal; the attempt is recorded as
 * failed and returned.
 *
 * `quiet` (the background re-check) records nothing when the answer has not changed since the
 * latest attempt; a person pressing Retry always gets a new row.
 */
export const syncCheckInToShopify = async (
  sql: Sql,
  input: { checkInId: string; actorId: string | null; gateway?: ShopifyReturnsGateway; force?: boolean; quiet?: boolean },
): Promise<WritebackState> => {
  const gateway = input.gateway ?? liveReturnsGateway;
  const facts = await checkInFacts(sql, input.checkInId);

  if (!input.force && !(await returnsWritebackEnabled(sql))) {
    return record(sql, facts, input.actorId, { outcome: 'skipped', action: 'none', message: 'Updating Shopify on check-in is switched off in Settings.' });
  }
  if (!facts.order_id || !facts.shopify_order_id || !facts.store) {
    return record(sql, facts, input.actorId, { outcome: 'skipped', action: 'none', message: 'This parcel has no Shopify order, so there is nothing to update in Shopify.' });
  }
  const orderId = facts.order_id;
  const store = facts.store;
  const shopifyOrderId = facts.shopify_order_id;

  return atomically(sql, async (tx) => {
    await lockOrder(tx, orderId);
    const ours = await unitsOfOrder(tx, orderId);
    const appliedBefore = await appliedForOrder(tx, orderId);
    const applied: Applied[] = [];
    let products: WritebackProduct[] = [];
    const reference = `logistics://monixys/order/${orderId}/returns`;

    try {
      const order = await gateway.order(store, shopifyOrderId);
      if (!order) {
        return record(tx, facts, input.actorId, { outcome: 'failed', action: 'none', message: `${facts.order_number} was not found in Shopify.`, error: 'order not found' });
      }
      const shopifyOf = (variant: string) => order.lines.filter((l) => l.variantId === variant);
      products = ours.map((o) => {
        const lines = shopifyOf(o.variant);
        const ordered = lines.reduce((n, l) => n + l.quantity, 0);
        const committed = lines.reduce((n, l) => n + l.committed, 0);
        const restockedByShopify = lines.reduce((n, l) => n + l.restocked, 0);
        const gone = Math.max(0, ordered - committed - restockedByShopify);
        const addedBefore = appliedBefore.get(o.variant)?.restock ?? 0;
        return {
          variant: o.variant,
          title: o.title,
          restocked: o.restocked,
          damaged: o.damaged,
          ordered,
          committed,
          restockedByShopify,
          addedBefore,
          addedNow: Math.max(0, Math.min(o.restocked, gone) - addedBefore),
          waiting: Math.min(o.restocked + o.damaged, committed),
          ahead: 0,
        };
      });
      for (const p of products) {
        p.ahead = Math.max(0, p.restockedByShopify + p.addedBefore + p.addedNow - p.restocked - (appliedBefore.get(p.variant)?.damaged ?? 0));
      }

      for (const product of products.filter((p) => p.addedNow > 0)) {
        const item = shopifyOf(product.variant).find((l) => l.inventoryItemGid)?.inventoryItemGid;
        const location = ours.find((o) => o.variant === product.variant)?.locationGid ?? order.locationGid;
        if (!item || !location) throw new Error(`Shopify has no stock record for variant ${product.variant}`);
        const target = product.addedBefore + product.addedNow;
        const key = idempotencyKey(`restock:${orderId}:${product.variant}:${target}`);
        await gateway.adjust(store, { reason: 'restock', key, reference, changes: [{ inventoryItemGid: item, locationGid: location, delta: product.addedNow }] });
        applied.push({ variant: product.variant, delta: product.addedNow, reason: 'restock', key });
      }

      const addedNow = products.reduce((n, p) => n + p.addedNow, 0);
      const addedBefore = products.reduce((n, p) => n + p.addedBefore, 0);
      const waiting = products.reduce((n, p) => n + p.waiting, 0);
      const byShopify = products.reduce((n, p) => n + Math.min(p.restockedByShopify, p.restocked), 0);
      const damaged = products.reduce((n, p) => n + p.damaged, 0);
      const ahead = products.reduce((n, p) => n + p.ahead, 0);

      const parts: string[] = [];
      if (addedNow > 0) parts.push(`${plural(addedNow, 'unit')} added back to available in Shopify.`);
      if (addedBefore > 0) parts.push(`${plural(addedBefore, 'unit')} had already been added back by the platform.`);
      if (byShopify > 0) parts.push(`Shopify had already restocked ${plural(byShopify, 'unit')} itself (${order.cancelled ? `${order.name} was cancelled with restock` : 'from a refund or return'}), so ${byShopify === 1 ? 'it was' : 'they were'} not added again.`);
      if (waiting > 0) {
        parts.push(
          `${order.name} is still open in Shopify, so ${plural(waiting, 'returned unit is', 'returned units are')} still committed to it. Nothing was added for them, so they are not counted twice: they become available when the order is cancelled with restock (Cancel in Shopify, here or in Shopify).`,
        );
      }
      if (damaged > 0) parts.push(`${plural(damaged, 'damaged unit')} not added to Shopify's stock.`);
      if (ours.length === 0) parts.push('No unit of this parcel is linked to a Shopify product, so nothing could be restocked there.');
      if (ahead > 0) parts.push(`Check Shopify: it shows ${plural(ahead, 'more unit')} of this order back in stock than came back in good condition.`);
      if (parts.length === 0) parts.push(`Nothing to change in Shopify for ${order.name}.`);

      const outcome: WritebackOutcome = waiting > 0 ? 'pending' : addedNow + addedBefore > 0 ? 'done' : 'skipped';
      const action: WritebackAction = addedNow > 0 ? 'restock' : 'none';
      const message = parts.join(' ');
      const detail = { products, applied, cancellable: waiting > 0 && !order.cancelled };

      if (input.quiet && applied.length === 0) {
        const latest = await latestRow(tx, facts.check_in_id);
        if (latest && latest.outcome === outcome && latest.detail.message === message) return unchanged(tx, facts.check_in_id, latest);
      }
      return record(tx, facts, input.actorId, { outcome, action, message, detail });
    } catch (error) {
      const message = friendly(error);
      logger.warn({ checkInId: facts.check_in_id, store, err: message }, 'Return not carried to Shopify');
      const done = applied.reduce((n, a) => n + a.delta, 0);
      const failed = {
        outcome: 'failed' as const,
        action: applied.length > 0 ? ('restock' as const) : ('none' as const),
        message: `Shopify was not updated${done > 0 ? ` completely (${plural(done, 'unit')} added before the failure)` : ''}: ${message}`,
        detail: { products, applied },
        error: message,
      };
      if (input.quiet && applied.length === 0) {
        const latest = await latestRow(tx, facts.check_in_id);
        if (latest && latest.outcome === 'failed' && latest.detail.message === failed.message) return unchanged(tx, facts.check_in_id, latest);
      }
      return record(tx, facts, input.actorId, failed);
    }
  });
};

/**
 * Cancels the Shopify order of a returned, checked-in parcel: the separate, explicit action a
 * person takes once the goods are back, so the units Shopify still holds as committed are freed.
 * Restocks the order's items only when units came back in good condition; damaged units freed by
 * the cancellation are then taken off available. Never refunds and never emails the customer (a
 * refused COD parcel was never paid for). Refused for an order Shopify has already cancelled, or
 * one with nothing committed (a fulfilled order is settled by restocking, not by cancelling).
 * Audited; the check-in's Shopify state is then re-derived.
 */
export const cancelShopifyOrderForReturn = async (
  sql: Sql,
  input: { checkInId: string; actorId: string; gateway?: ShopifyReturnsGateway },
): Promise<WritebackState> => {
  const gateway = input.gateway ?? liveReturnsGateway;
  const facts = await checkInFacts(sql, input.checkInId);
  if (!facts.order_id || !facts.shopify_order_id || !facts.store) throw new ReturnsActionError('This parcel has no Shopify order to cancel.');
  const orderId = facts.order_id;
  const store = facts.store;
  const shopifyOrderId = facts.shopify_order_id;

  const cancelled = await atomically(sql, async (tx) => {
    await lockOrder(tx, orderId);
    const order = await gateway.order(store, shopifyOrderId).catch((error: unknown) => {
      throw new ReturnsActionError(friendly(error), 502);
    });
    if (!order) throw new ReturnsActionError(`${facts.order_number} was not found in Shopify.`);
    if (order.cancelled) throw new ReturnsActionError(`${order.name} is already cancelled in Shopify.`);
    const committed = order.lines.reduce((n, l) => n + l.committed, 0);
    if (committed === 0) throw new ReturnsActionError(`${order.name} has nothing committed in Shopify (it is ${order.fulfillment.toLowerCase().replace(/_/g, ' ')}), so there is nothing to free by cancelling it.`);

    const ours = await unitsOfOrder(tx, orderId);
    const restock = ours.some((o) => o.restocked > 0);
    const applied: Applied[] = [];
    try {
      await gateway.cancel(store, shopifyOrderId, {
        restock,
        staffNote: `Returned by PostEx (${facts.tracking_number}); cancelled from Monixys after check-in${restock ? ', items restocked' : ', damaged: not restocked'}.`,
      });
      // Cancelling with restock freed every committed unit; the damaged ones among them are not stock.
      if (restock) {
        for (const o of ours.filter((u) => u.damaged > 0)) {
          const lines = order.lines.filter((l) => l.variantId === o.variant);
          const freed = Math.min(o.damaged, lines.reduce((n, l) => n + l.committed, 0));
          const item = lines.find((l) => l.inventoryItemGid)?.inventoryItemGid;
          const location = o.locationGid ?? order.locationGid;
          if (freed === 0 || !item || !location) continue;
          const key = idempotencyKey(`damaged:${orderId}:${o.variant}:${freed}`);
          await gateway.adjust(store, { reason: 'damaged', key, reference: `logistics://monixys/order/${orderId}/returns`, changes: [{ inventoryItemGid: item, locationGid: location, delta: -freed }] });
          applied.push({ variant: o.variant, delta: -freed, reason: 'damaged', key });
        }
      }
    } catch (error) {
      const message = friendly(error);
      await record(tx, facts, input.actorId, { outcome: 'failed', action: 'cancel', message: `${order.name} was not cancelled in Shopify: ${message}`, detail: { applied }, error: message });
      return { ok: false as const, message };
    }
    await tx`
      insert into audit_log (actor_id, action, entity, entity_id, after)
      values (${input.actorId}, 'shopify.order_cancel', 'orders', ${orderId}, ${tx.json({ checkInId: facts.check_in_id, restock, writtenOff: applied } as never)})
    `;
    await record(tx, facts, input.actorId, {
      outcome: 'done',
      action: 'cancel',
      message: `${order.name} cancelled in Shopify ${restock ? 'with its items restocked' : 'without restocking (damaged)'}; no refund, customer not notified.`,
      detail: { applied },
    });
    return { ok: true as const };
  });
  if (!cancelled.ok) throw new ReturnsActionError(`Shopify was not updated: ${cancelled.message}`, 502);
  // Where the stock stands now that the order is settled: usually nothing left to do.
  return syncCheckInToShopify(sql, { checkInId: facts.check_in_id, actorId: input.actorId, gateway, force: true });
};

/**
 * Check-ins whose latest Shopify attempt is waiting on the order or failed, last tried more than
 * `olderThanMs` ago: what shopify:catchup re-checks, so an order cancelled in Shopify, or Shopify
 * coming back, settles the return without anyone pressing Retry.
 */
export const writebacksToRecheck = async (db: Db, olderThanMs: number, limit = 50): Promise<string[]> => {
  const rows = await db<{ check_in_id: string }[]>`
    select w.check_in_id from (
      select distinct on (check_in_id) check_in_id, outcome, at from shopify_writebacks order by check_in_id, at desc, id desc
    ) w
    left join shopify_writeback_checks k on k.check_in_id = w.check_in_id
    where w.outcome in ('pending', 'failed') and greatest(w.at, k.checked_at) < now() - ${`${olderThanMs} milliseconds`}::interval
    order by greatest(w.at, k.checked_at)
    limit ${limit}
  `;
  return rows.map((r) => r.check_in_id);
};
