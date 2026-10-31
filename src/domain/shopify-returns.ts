import { createHash } from 'node:crypto';

import type { Sql } from '../db.js';
import { STAGE_SQL } from '../db/repos/parcels.js';
import { type Db, atomically } from '../db/repos/upsert.js';
import { shopifyClient } from '../integrations/shopify/client.js';
import { logger } from '../logger.js';

/**
 * A return check-in, carried through to Shopify, so the store's order and stock say what the shelf
 * says. Every button a person presses on a return (Restock, Damaged, Split, Retry) settles the
 * order in Shopify, the way the order stands there when it is read live:
 *
 * - **Open, units still committed** (a refused COD parcel: the order was never fulfilled): the
 *   order is cancelled, with restock if any unit came back in good condition; damaged units the
 *   cancel frees are then taken off available. Never while another parcel of the order is still
 *   out with PostEx (a re-sent order), never with a refund, never emailing the customer.
 * - **Fulfilled** (Shopify counts the units as gone): a Shopify return is recorded for the units
 *   that came back and not yet taken back by a return or refund, each disposed of as restocked
 *   (good) or not restocked (damaged), and closed. A return already open in Shopify for them is
 *   used rather than a second one made.
 * - **Cancelled already**: nothing is cancelled or returned; units Shopify did not restock are
 *   added back to available below.
 *
 * The background re-check (`quiet`) never cancels and never records a return: those happen only
 * when a person presses a button. It only reads, and adds stock Shopify counts as gone.
 *
 * Then, per product, over every parcel of the order (so a re-sent order is not restocked twice):
 *
 *   gone       = ordered − still committed − already restocked by Shopify
 *   add now    = min(units checked in as restocked, gone) − units the platform already added
 *
 * - **Still committed**: units on an order that is open and not fulfilled. Adding them would count
 *   them twice the moment the order is cancelled with restock, so the attempt is `pending` until
 *   the order is cancelled.
 * - **Already restocked by Shopify**: units put back by a cancel or refund with restock, or a
 *   RESTOCKED disposition on a return (including the ones recorded here). A cancelled order whose
 *   items were not restocked (NO_RESTOCK) counts them as gone, so they are added back.
 * - **Already added by the platform**: every adjustment this code made for the order, as recorded.
 *   A unit added that way is disposed of as not restocked if a return is recorded later, so it is
 *   never counted twice.
 *
 * Shopify is read again after every change, and every step only does what the fresh read says is
 * still missing; with an idempotency key per adjustment and a transaction-scoped advisory lock per
 * order, a retry, a double click or two people at once cancel once, return once and add once.
 * Damaged units are never added. A Shopify failure is recorded as `failed` with Shopify's reason and
 * is never reported as done; what Shopify did accept before the failure stands, so a retry does
 * only what is left. Every attempt is a row in `shopify_writebacks` (append-only).
 */

export type WritebackOutcome = 'done' | 'skipped' | 'failed' | 'pending';
/** `cancel_restock` and `write_off` are kept for attempts recorded before restock and cancel were separated. */
export type WritebackAction = 'restock' | 'cancel' | 'return' | 'none' | 'cancel_restock' | 'write_off';

export interface ShopifyOrderLine {
  lineItemGid: string;
  /** Numeric Shopify variant id; null for a custom line. */
  variantId: string | null;
  inventoryItemGid: string | null;
  quantity: number;
  /** Units still committed to the order: unfulfilled, on an order that is not cancelled. */
  committed: number;
  /** Units Shopify has already put back: on cancellation or refund with restock, or from a return. */
  restocked: number;
  /** Units refunded, restocked or not: Shopify will not put a refunded unit on a return. */
  refunded: number;
}

/** A fulfilled unit Shopify could take back on a return (successful fulfillments only). */
export interface ShopifyFulfilledItem {
  fulfillmentLineItemGid: string;
  lineItemGid: string;
  variantId: string | null;
  quantity: number;
  /** Units of it already on a return that was not cancelled or declined. */
  returned: number;
}

/** A Shopify return that was not cancelled or declined, with what is left to dispose of per line. */
export interface ShopifyReturnRecord {
  gid: string;
  name: string;
  /** OPEN, CLOSED or REQUESTED. */
  status: string;
  /** `rfoGid`: the reverse fulfillment order the line belongs to; Shopify disposes of one at a time. */
  lines: Array<{ gid: string; rfoGid: string; variantId: string | null; total: number; disposed: number }>;
}

export interface ShopifyOrderFacts {
  name: string;
  cancelled: boolean;
  /** `displayFulfillmentStatus`: UNFULFILLED, FULFILLED, PARTIALLY_FULFILLED, RESTOCKED, … */
  fulfillment: string;
  /** Where a fulfilment was sent from, when there is one. */
  locationGid: string | null;
  lines: ShopifyOrderLine[];
  fulfilled: ShopifyFulfilledItem[];
  returns: ShopifyReturnRecord[];
}

export interface InventoryChange {
  inventoryItemGid: string;
  locationGid: string;
  delta: number;
}

/** One reverse-fulfillment line of a return, disposed of as restocked (at a location) or not. */
export interface Disposition {
  lineGid: string;
  quantity: number;
  restock: boolean;
  locationGid: string | null;
}

/** The calls the write-back makes. The default calls the real stores; tests pass their own. */
export interface ShopifyReturnsGateway {
  order(store: string, shopifyOrderId: string): Promise<ShopifyOrderFacts | null>;
  cancel(store: string, shopifyOrderId: string, input: { staffNote: string; restock: boolean }): Promise<void>;
  adjust(store: string, input: { reason: 'restock' | 'damaged'; key: string; reference: string; changes: InventoryChange[] }): Promise<void>;
  createReturn(store: string, shopifyOrderId: string, input: { items: Array<{ fulfillmentLineItemGid: string; quantity: number }>; note: string }): Promise<void>;
  dispose(store: string, dispositions: Disposition[]): Promise<void>;
  closeReturn(store: string, returnGid: string): Promise<void>;
}

const userErrors = (errors: Array<{ message: string }> | undefined): void => {
  if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '));
};

interface OrderNode {
  name: string;
  cancelledAt: string | null;
  displayFulfillmentStatus: string;
  fulfillments: Array<{ status: string; location: { id: string } | null; fulfillmentLineItems: { nodes: Array<{ id: string; quantity: number | null; lineItem: { id: string } }> } }>;
  lineItems: { nodes: Array<{ id: string; quantity: number; unfulfilledQuantity: number; variant: { id: string; inventoryItem: { id: string } | null } | null }> };
  refunds: Array<{ refundLineItems: { nodes: Array<{ quantity: number; restocked: boolean; restockType: string; lineItem: { id: string } | null }> } }>;
  returns: {
    nodes: Array<{
      id: string;
      name: string;
      status: string;
      returnLineItems: { nodes: Array<{ quantity?: number; fulfillmentLineItem?: { id: string } | null }> };
      reverseFulfillmentOrders: {
        nodes: Array<{
          id: string;
          lineItems: {
            nodes: Array<{ id: string; totalQuantity: number; fulfillmentLineItem: { id: string; lineItem: { id: string } | null } | null; dispositions: Array<{ type: string; quantity: number }> }>;
          };
        }>;
      };
    }>;
  };
}

const ORDER_FACTS_QUERY = `
  query ReturnOrder($id: ID!) {
    order(id: $id) {
      name cancelledAt displayFulfillmentStatus
      fulfillments(first: 10) { status location { id } fulfillmentLineItems(first: 50) { nodes { id quantity lineItem { id } } } }
      lineItems(first: 100) { nodes { id quantity unfulfilledQuantity variant { id inventoryItem { id } } } }
      refunds(first: 20) { refundLineItems(first: 100) { nodes { quantity restocked restockType lineItem { id } } } }
      returns(first: 10) {
        nodes {
          id name status
          returnLineItems(first: 50) { nodes { ... on ReturnLineItem { quantity fulfillmentLineItem { id } } } }
          reverseFulfillmentOrders(first: 5) { nodes { id lineItems(first: 50) { nodes { id totalQuantity fulfillmentLineItem { id lineItem { id } } dispositions { type quantity } } } } }
        }
      }
    }
  }
`;

const add = (map: Map<string, number>, key: string | undefined, n: number) => {
  if (key) map.set(key, (map.get(key) ?? 0) + n);
};

/** A return Shopify dropped (cancelled or declined) takes nothing back. */
const liveReturn = (status: string) => status !== 'CANCELED' && status !== 'DECLINED';

/**
 * Shopify's order as the write-back needs it: per line, what is still committed and what Shopify
 * already put back; what was fulfilled and how much of it is already on a return; and the returns
 * themselves. A unit restocked from a return can show both as a restocked refund line (type
 * RETURN) and as a RESTOCKED disposition, so the disposition only counts beyond the refund lines.
 * A cancelled order keeps its `unfulfilledQuantity` (live data, Oct 2026), so it commits nothing.
 * Only successful fulfillments count: a cancelled one sent nothing (seen on live orders).
 */
export const orderFactsFrom = (node: OrderNode): ShopifyOrderFacts => {
  const restockedByRefund = new Map<string, number>();
  const refundedOnReturn = new Map<string, number>();
  const refunded = new Map<string, number>();
  for (const refund of node.refunds) {
    for (const line of refund.refundLineItems.nodes) {
      add(refunded, line.lineItem?.id, line.quantity);
      if (!line.restocked) continue;
      add(restockedByRefund, line.lineItem?.id, line.quantity);
      if (line.restockType === 'RETURN') add(refundedOnReturn, line.lineItem?.id, line.quantity);
    }
  }
  const disposed = new Map<string, number>();
  const returnedByItem = new Map<string, number>();
  for (const ret of node.returns.nodes) {
    if (liveReturn(ret.status)) for (const line of ret.returnLineItems.nodes) add(returnedByItem, line.fulfillmentLineItem?.id, line.quantity ?? 0);
    for (const rfo of ret.reverseFulfillmentOrders.nodes) {
      for (const line of rfo.lineItems.nodes) {
        for (const d of line.dispositions) if (d.type === 'RESTOCKED') add(disposed, line.fulfillmentLineItem?.lineItem?.id, d.quantity);
      }
    }
  }
  const variantOf = new Map(node.lineItems.nodes.map((l) => [l.id, l.variant ? l.variant.id.replace('gid://shopify/ProductVariant/', '') : null]));
  const sent = node.fulfillments.filter((f) => f.status === 'SUCCESS');
  const cancelled = node.cancelledAt !== null;
  return {
    name: node.name,
    cancelled,
    fulfillment: node.displayFulfillmentStatus,
    locationGid: (sent.find((f) => f.location) ?? node.fulfillments.find((f) => f.location))?.location?.id ?? null,
    lines: node.lineItems.nodes.map((line) => ({
      lineItemGid: line.id,
      variantId: variantOf.get(line.id) ?? null,
      inventoryItemGid: line.variant?.inventoryItem?.id ?? null,
      quantity: line.quantity,
      committed: cancelled ? 0 : Math.max(0, line.unfulfilledQuantity),
      restocked: (restockedByRefund.get(line.id) ?? 0) + Math.max(0, (disposed.get(line.id) ?? 0) - (refundedOnReturn.get(line.id) ?? 0)),
      refunded: refunded.get(line.id) ?? 0,
    })),
    fulfilled: sent.flatMap((f) =>
      f.fulfillmentLineItems.nodes.map((item) => ({
        fulfillmentLineItemGid: item.id,
        lineItemGid: item.lineItem.id,
        variantId: variantOf.get(item.lineItem.id) ?? null,
        quantity: item.quantity ?? 0,
        returned: returnedByItem.get(item.id) ?? 0,
      })),
    ),
    returns: node.returns.nodes
      .filter((r) => liveReturn(r.status))
      .map((r) => ({
        gid: r.id,
        name: r.name,
        status: r.status,
        lines: r.reverseFulfillmentOrders.nodes.flatMap((rfo) =>
          rfo.lineItems.nodes.map((line) => ({
            gid: line.id,
            rfoGid: rfo.id,
            variantId: variantOf.get(line.fulfillmentLineItem?.lineItem?.id ?? '') ?? null,
            total: line.totalQuantity,
            disposed: line.dispositions.reduce((n, d) => n + d.quantity, 0),
          })),
        ),
      })),
  };
};

const reasons = new Map<string, string>();

/**
 * The return reason a recorded return carries: Shopify requires one per line (a reason definition
 * since the old enum was deprecated). "Other", with the note naming the PostEx parcel; found by its
 * handle in Shopify's shared library rather than by an id written here, and kept per store.
 */
const returnReason = async (store: string): Promise<string> => {
  const known = reasons.get(store);
  if (known) return known;
  const data = await shopifyClient(store).graphql<{ returnReasonDefinitions: { nodes: Array<{ id: string; handle: string }> } }>(
    `{ returnReasonDefinitions(first: 50) { nodes { id handle } } }`,
    {},
  );
  const nodes = data.returnReasonDefinitions.nodes;
  const found = (nodes.find((n) => n.handle === 'other-reason') ?? nodes.find((n) => n.handle === 'unknown'))?.id;
  if (!found) throw new Error('Shopify offers no "Other" return reason to record the return with');
  reasons.set(store, found);
  return found;
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
  createReturn: async (store, shopifyOrderId, input) => {
    const reason = await returnReason(store);
    const data = await shopifyClient(store).graphql<{ returnCreate: { userErrors: Array<{ message: string }> } }>(
      `mutation ReturnCreate($input: ReturnInput!) { returnCreate(returnInput: $input) { return { id } userErrors { field message code } } }`,
      {
        input: {
          orderId: `gid://shopify/Order/${shopifyOrderId}`,
          returnLineItems: input.items.map((i) => ({ fulfillmentLineItemId: i.fulfillmentLineItemGid, quantity: i.quantity, returnReasonDefinitionId: reason, returnReasonNote: input.note.slice(0, 255) })),
        },
      },
    );
    userErrors(data.returnCreate.userErrors);
  },
  dispose: async (store, dispositions) => {
    const data = await shopifyClient(store).graphql<{ reverseFulfillmentOrderDispose: { userErrors: Array<{ message: string }> } }>(
      `mutation ReturnDispose($inputs: [ReverseFulfillmentOrderDisposeInput!]!) { reverseFulfillmentOrderDispose(dispositionInputs: $inputs) { userErrors { field message code } } }`,
      {
        inputs: dispositions.map((d) => ({
          reverseFulfillmentOrderLineItemId: d.lineGid,
          quantity: d.quantity,
          dispositionType: d.restock ? 'RESTOCKED' : 'NOT_RESTOCKED',
          ...(d.restock ? { locationId: d.locationGid } : {}),
        })),
      },
    );
    userErrors(data.reverseFulfillmentOrderDispose.userErrors);
  },
  closeReturn: async (store, returnGid) => {
    const data = await shopifyClient(store).graphql<{ returnClose: { userErrors: Array<{ message: string }> } }>(
      `mutation ReturnClose($id: ID!) { returnClose(id: $id) { return { id status } userErrors { field message code } } }`,
      { id: returnGid },
    );
    userErrors(data.returnClose.userErrors);
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
  /** Set when this attempt cancelled the order in Shopify. */
  cancelled?: boolean;
  /** Shopify returns this attempt opened, disposed of or closed: the ones the platform may close later. */
  returns?: Array<{ gid: string; name: string }>;
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
  shipment_id: string;
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

/** A Shopify failure in words for the screen: unreachable, not permitted, or Shopify's own reason. */
export const friendly = (error: unknown): string => {
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
    select c.id as check_in_id, c.outcome, s.id as shipment_id, s.tracking_number, o.id as order_id, o.order_number, o.shopify_order_id::text, st.key as store, st.id as store_id
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

/**
 * What earlier attempts did to the order itself: the Shopify returns the platform opened or
 * disposed of (once fully disposed of, it closes them), and whether it cancelled the order.
 */
const earlierAttempts = async (db: Db, orderId: string): Promise<{ returns: Set<string>; cancelled: boolean }> => {
  const rows = await db<{ action: WritebackAction; outcome: WritebackOutcome; detail: WritebackDetail }[]>`
    select w.action, w.outcome, w.detail from shopify_writebacks w
    join return_check_ins c on c.id = w.check_in_id
    join shipments s on s.id = c.shipment_id
    where s.order_id = ${orderId}
  `;
  return {
    returns: new Set(rows.flatMap((r) => (r.detail.returns ?? []).map((x) => x.gid))),
    cancelled: rows.some((r) => r.detail.cancelled === true || (r.outcome === 'done' && (r.action === 'cancel' || r.action === 'cancel_restock'))),
  };
};

/**
 * The order's other parcels that are not on their way back: a re-sent order can have one refused
 * and another still being delivered, and cancelling it would cancel a sale in progress.
 */
const parcelsStillOut = async (db: Db, orderId: string, shipmentId: string): Promise<string[]> => {
  const rows = await db<{ tracking_number: string }[]>`
    select s.tracking_number from shipments s
    where s.order_id = ${orderId} and s.id <> ${shipmentId}
      and ${db.unsafe(STAGE_SQL)} not in ('returning', 'returned', 'cancelled')
    order by s.id
  `;
  return rows.map((r) => r.tracking_number);
};

type Returned = Pick<Ours, 'variant' | 'restocked' | 'damaged'>;

/**
 * What a new Shopify return takes back: per product, the units checked in that Shopify has not
 * already taken back on a return or by a refund, from fulfilled units with room left. Shopify will
 * not put a refunded unit on a return, so a refund outside a return counts as taken back.
 */
export const itemsToReturn = (order: ShopifyOrderFacts, ours: readonly Returned[]): Array<{ fulfillmentLineItemGid: string; quantity: number }> => {
  const items: Array<{ fulfillmentLineItemGid: string; quantity: number }> = [];
  for (const o of ours) {
    const lines = order.lines.filter((l) => l.variantId === o.variant);
    const sentOf = (line: ShopifyOrderLine) => order.fulfilled.filter((f) => f.lineItemGid === line.lineItemGid);
    const takenBack = (line: ShopifyOrderLine) => Math.max(sentOf(line).reduce((n, f) => n + f.returned, 0), line.refunded);
    let need = Math.max(0, o.restocked + o.damaged - lines.reduce((n, l) => n + takenBack(l), 0));
    for (const line of lines) {
      let room = Math.max(0, sentOf(line).reduce((n, f) => n + f.quantity, 0) - takenBack(line));
      for (const item of sentOf(line)) {
        const quantity = Math.min(need, room, item.quantity - item.returned);
        if (quantity <= 0) continue;
        items.push({ fulfillmentLineItemGid: item.fulfillmentLineItemGid, quantity });
        need -= quantity;
        room -= quantity;
      }
    }
  }
  return items;
};

/**
 * How to dispose of what is still open on the order's returns, per product: never more than came
 * back, restocking only units that came back fine and are not in Shopify's stock already (by its
 * own restock, or added by the platform before), and the rest not restocked.
 */
export const dispositionsFor = (
  order: ShopifyOrderFacts,
  ours: ReadonlyArray<Returned & { locationGid: string | null }>,
  addedBefore: ReadonlyMap<string, { restock: number }>,
): Array<Disposition & { returnGid: string; rfoGid: string }> => {
  const out: Array<Disposition & { returnGid: string; rfoGid: string }> = [];
  for (const o of ours) {
    const open = order.returns
      .filter((r) => r.status === 'OPEN')
      .flatMap((r) => r.lines.filter((l) => l.variantId === o.variant && l.total > l.disposed).map((l) => ({ ...l, returnGid: r.gid })));
    if (open.length === 0) continue;
    const disposed = order.returns.flatMap((r) => r.lines).filter((l) => l.variantId === o.variant).reduce((n, l) => n + l.disposed, 0);
    const inStock = order.lines.filter((l) => l.variantId === o.variant).reduce((n, l) => n + l.restocked, 0) + (addedBefore.get(o.variant)?.restock ?? 0);
    let left = Math.max(0, o.restocked + o.damaged - disposed);
    let restock = Math.max(0, o.restocked - inStock);
    for (const line of open) {
      const quantity = Math.min(left, line.total - line.disposed);
      if (quantity <= 0) break;
      const good = Math.min(quantity, restock);
      if (good > 0) out.push({ returnGid: line.returnGid, rfoGid: line.rfoGid, lineGid: line.gid, quantity: good, restock: true, locationGid: o.locationGid ?? order.locationGid });
      if (quantity > good) out.push({ returnGid: line.returnGid, rfoGid: line.rfoGid, lineGid: line.gid, quantity: quantity - good, restock: false, locationGid: null });
      left -= quantity;
      restock -= good;
    }
  }
  return out;
};

/** Cancels the open order in Shopify, restocking only if some units came back fine. Audited. Throws on a refusal. */
const cancelOrder = async (
  tx: Db,
  gateway: ShopifyReturnsGateway,
  c: { store: string; shopifyOrderId: string; orderId: string; facts: CheckInFacts; ours: Ours[]; actorId: string | null },
): Promise<boolean> => {
  const restock = c.ours.some((o) => o.restocked > 0);
  await gateway.cancel(c.store, c.shopifyOrderId, {
    restock,
    staffNote: `Returned by PostEx (${c.facts.tracking_number}); cancelled from Monixys after check-in${restock ? ', items restocked' : ', damaged: not restocked'}.`,
  });
  await tx`
    insert into audit_log (actor_id, action, entity, entity_id, after)
    values (${c.actorId}, 'shopify.order_cancel', 'orders', ${c.orderId}, ${tx.json({ checkInId: c.facts.check_in_id, restock } as never)})
  `;
  return restock;
};

/** After a cancel with restock, takes the damaged units it freed back off available. `order` is as read before the cancel. */
const writeOffFreedDamaged = async (
  gateway: ShopifyReturnsGateway,
  c: { store: string; orderId: string; order: ShopifyOrderFacts; ours: Ours[] },
): Promise<Applied[]> => {
  const applied: Applied[] = [];
  for (const o of c.ours.filter((u) => u.damaged > 0)) {
    const lines = c.order.lines.filter((l) => l.variantId === o.variant);
    const freed = Math.min(o.damaged, lines.reduce((n, l) => n + l.committed, 0));
    const item = lines.find((l) => l.inventoryItemGid)?.inventoryItemGid;
    const location = o.locationGid ?? c.order.locationGid;
    if (freed === 0 || !item || !location) continue;
    const key = idempotencyKey(`damaged:${c.orderId}:${o.variant}:${freed}`);
    await gateway.adjust(c.store, { reason: 'damaged', key, reference: `logistics://monixys/order/${c.orderId}/returns`, changes: [{ inventoryItemGid: item, locationGid: location, delta: -freed }] });
    applied.push({ variant: o.variant, delta: -freed, reason: 'damaged', key });
  }
  return applied;
};

const idempotencyKey = (parts: string): string => `nur-return-${createHash('sha256').update(parts).digest('hex').slice(0, 40)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Settles an order's checked-in returns in Shopify, and records the attempt: cancels the order if
 * it is still open with returned units committed to it, records a return for fulfilled units that
 * came back, then adds back stock Shopify still counts as gone (see the top of this file). Safe to
 * call any number of times, at once or in a row: every step does only what a fresh read of Shopify
 * says is still missing. Never throws for a Shopify refusal; the attempt is recorded as failed and
 * returned.
 *
 * `quiet` (the background re-check) never cancels or records a return, and records nothing when the
 * answer has not changed since the latest attempt; a person pressing a button always gets a new row.
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
  const act = !input.quiet;

  return atomically(sql, async (tx) => {
    await lockOrder(tx, orderId);
    const ours = await unitsOfOrder(tx, orderId);
    const appliedBefore = await appliedForOrder(tx, orderId);
    const earlier = await earlierAttempts(tx, orderId);
    const applied: Applied[] = [];
    const touched: Array<{ gid: string; name: string }> = [];
    const done: string[] = [];
    let cancelled = false;
    let products: WritebackProduct[] = [];
    const reference = `logistics://monixys/order/${orderId}/returns`;
    const touch = (gid: string, name: string) => {
      if (!touched.some((t) => t.gid === gid)) touched.push({ gid, name });
    };

    try {
      let order = await gateway.order(store, shopifyOrderId);
      if (!order) {
        return record(tx, facts, input.actorId, { outcome: 'failed', action: 'none', message: `${facts.order_number} was not found in Shopify.`, error: 'order not found' });
      }
      const reread = async (): Promise<ShopifyOrderFacts> => {
        const again = await gateway.order(store, shopifyOrderId);
        if (!again) throw new Error(`${facts.order_number} is no longer in Shopify`);
        return again;
      };
      let blocked: string | null = null;

      // Open with the returned units still committed to it: the parcel was refused, so the sale is off.
      if (act && !order.cancelled && ours.length > 0 && order.lines.some((l) => l.committed > 0)) {
        const out = await parcelsStillOut(tx, orderId, facts.shipment_id);
        if (out.length > 0) {
          blocked = `${order.name} was not cancelled in Shopify: its other parcel ${out.join(', ')} is still out with PostEx.`;
        } else {
          const restock = await cancelOrder(tx, gateway, { store, shopifyOrderId, orderId, facts, ours, actorId: input.actorId });
          cancelled = true;
          done.push(`${order.name} cancelled in Shopify ${restock ? 'with its items restocked' : 'without restocking (damaged)'}; no refund, customer not notified.`);
          if (restock) applied.push(...(await writeOffFreedDamaged(gateway, { store, orderId, order, ours })));
          order = await reread();
        }
      }

      // Fulfilled units that came back: a Shopify return, disposed of and closed.
      if (act && !order.cancelled) {
        const items = itemsToReturn(order, ours);
        if (items.length > 0) {
          const before = new Set(order.returns.map((r) => r.gid));
          await gateway.createReturn(store, shopifyOrderId, { items, note: `Returned by PostEx (${facts.tracking_number}); recorded from Monixys at check-in.` });
          order = await reread();
          for (const r of order.returns) if (!before.has(r.gid)) touch(r.gid, r.name);
        }
        const dispositions = dispositionsFor(order, ours, appliedBefore);
        if (dispositions.some((d) => d.restock && !d.locationGid)) throw new Error(`Shopify has no location to restock ${order.name}'s return at`);
        if (dispositions.length > 0) {
          // Shopify disposes of one reverse fulfillment order per call.
          for (const rfo of new Set(dispositions.map((d) => d.rfoGid))) {
            await gateway.dispose(store, dispositions.filter((d) => d.rfoGid === rfo).map(({ returnGid: _r, rfoGid: _o, ...d }) => d));
          }
          for (const d of dispositions) touch(d.returnGid, order.returns.find((r) => r.gid === d.returnGid)?.name ?? '');
          order = await reread();
        }
        const mine = new Set([...earlier.returns, ...touched.map((t) => t.gid)]);
        const closing = order.returns.filter((r) => r.status === 'OPEN' && mine.has(r.gid) && r.lines.every((l) => l.disposed >= l.total));
        for (const r of closing) {
          await gateway.closeReturn(store, r.gid);
          touch(r.gid, r.name);
        }
        if (touched.length > 0) {
          const good = dispositions.filter((d) => d.restock).reduce((n, d) => n + d.quantity, 0);
          const bad = dispositions.filter((d) => !d.restock).reduce((n, d) => n + d.quantity, 0);
          const what = [good > 0 && `${plural(good, 'unit')} restocked`, bad > 0 && `${plural(bad, 'unit')} not restocked (damaged)`].filter(Boolean).join(', ');
          done.push(`Return ${touched.map((t) => t.name).join(', ')} recorded in Shopify for ${order.name}${what ? `: ${what}` : ''}${closing.length > 0 ? ', and closed' : ''}; no refund, customer not notified.`);
        }
        if (closing.length > 0) order = await reread();
      }

      const shopifyOf = (variant: string) => order!.lines.filter((l) => l.variantId === variant);
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
          // Good units Shopify has not put back itself: a unit it holds as gone may be a damaged one
          // (disposed of as not restocked), which must not be added in place of a good one.
          addedNow: Math.max(0, Math.min(o.restocked - restockedByShopify, gone) - addedBefore),
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

      const parts: string[] = [...done];
      if (blocked) parts.push(blocked);
      if (addedNow > 0) parts.push(`${plural(addedNow, 'unit')} added back to available in Shopify.`);
      if (addedBefore > 0) parts.push(`${plural(addedBefore, 'unit')} had already been added back by the platform.`);
      // What this attempt did itself is said above; this is for what Shopify had done before.
      if (byShopify > 0 && done.length === 0) {
        parts.push(`Shopify had already restocked ${plural(byShopify, 'unit')} itself (${order.cancelled ? `${order.name} was cancelled with restock` : 'from a refund or return'}), so ${byShopify === 1 ? 'it was' : 'they were'} not added again.`);
      }
      if (waiting > 0) {
        parts.push(
          `${order.name} is still open in Shopify, so ${plural(waiting, 'returned unit is', 'returned units are')} still committed to it. Nothing was added for them, so they are not counted twice: they become available when the order is cancelled with restock (Retry or Cancel in Shopify here, or cancel it in Shopify).`,
        );
      }
      if (damaged > 0 && done.length === 0) parts.push(`${plural(damaged, 'damaged unit')} not added to Shopify's stock.`);
      if (ours.length === 0) parts.push('No unit of this parcel is linked to a Shopify product, so nothing could be changed in Shopify.');
      if (ahead > 0) parts.push(`Check Shopify: it shows ${plural(ahead, 'more unit')} of this order back in stock than came back in good condition.`);
      if (parts.length === 0) parts.push(`Nothing to change in Shopify for ${order.name}.`);

      const changed = cancelled || touched.length > 0 || addedNow > 0;
      const outcome: WritebackOutcome = waiting > 0 ? 'pending' : changed || addedBefore > 0 || earlier.returns.size > 0 || earlier.cancelled ? 'done' : 'skipped';
      const action: WritebackAction = cancelled ? 'cancel' : touched.length > 0 ? 'return' : addedNow > 0 ? 'restock' : 'none';
      const message = parts.join(' ');
      const detail = { products, applied, cancellable: waiting > 0 && !order.cancelled, cancelled, returns: touched };

      if (input.quiet && applied.length === 0) {
        const latest = await latestRow(tx, facts.check_in_id);
        if (latest && latest.outcome === outcome && latest.detail.message === message) return unchanged(tx, facts.check_in_id, latest);
      }
      return record(tx, facts, input.actorId, { outcome, action, message, detail });
    } catch (error) {
      const message = friendly(error);
      logger.warn({ checkInId: facts.check_in_id, store, err: message }, 'Return not carried to Shopify');
      const added = applied.filter((a) => a.reason === 'restock').reduce((n, a) => n + a.delta, 0);
      const already = [...done, added > 0 ? `${plural(added, 'unit')} added back to available.` : ''].filter(Boolean).join(' ');
      const failed = {
        outcome: 'failed' as const,
        action: cancelled ? ('cancel' as const) : touched.length > 0 ? ('return' as const) : applied.length > 0 ? ('restock' as const) : ('none' as const),
        message: already ? `Shopify was only partly updated (${already}) before it failed: ${message} Press Retry to finish.` : `Shopify was not updated: ${message}`,
        detail: { products, applied, cancelled, returns: touched },
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
 * Cancels the Shopify order of a returned, checked-in parcel, for an order still open there: what
 * Restock, Damaged and Split already do on check-in, kept as its own button for a return checked
 * in while that was not so (or when the cancel was refused). Restocks the order's items only when
 * units came back in good condition; damaged units freed by the cancellation are then taken off
 * available. Never refunds and never emails the customer (a refused COD parcel was never paid for).
 * Refused for an order Shopify has already cancelled, one with nothing committed (a fulfilled order
 * is settled by a return, not a cancel), or one with another parcel still out. Audited; the
 * check-in's Shopify state is then re-derived.
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
    const out = await parcelsStillOut(tx, orderId, facts.shipment_id);
    if (out.length > 0) throw new ReturnsActionError(`${order.name} is not cancelled: its other parcel ${out.join(', ')} is still out with PostEx.`);

    const ours = await unitsOfOrder(tx, orderId);
    const applied: Applied[] = [];
    let restock = false;
    let done = false;
    try {
      restock = await cancelOrder(tx, gateway, { store, shopifyOrderId, orderId, facts, ours, actorId: input.actorId });
      done = true;
      if (restock) applied.push(...(await writeOffFreedDamaged(gateway, { store, orderId, order, ours })));
    } catch (error) {
      const message = friendly(error);
      await record(tx, facts, input.actorId, {
        outcome: 'failed',
        action: 'cancel',
        message: done ? `${order.name} was cancelled in Shopify, but its damaged units were not taken off available: ${message}` : `${order.name} was not cancelled in Shopify: ${message}`,
        detail: { applied, cancelled: done },
        error: message,
      });
      return { ok: false as const, message };
    }
    await record(tx, facts, input.actorId, {
      outcome: 'done',
      action: 'cancel',
      message: `${order.name} cancelled in Shopify ${restock ? 'with its items restocked' : 'without restocking (damaged)'}; no refund, customer not notified.`,
      detail: { applied, cancelled: true },
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
