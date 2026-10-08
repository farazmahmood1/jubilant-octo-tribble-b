import type { Sql } from '../db.js';
import type { Db } from '../db/repos/upsert.js';
import { shopifyClient } from '../integrations/shopify/client.js';
import { logger } from '../logger.js';

/**
 * A return check-in, carried through to Shopify, so the store's stock says what the shelf says.
 *
 * The platform's own stock moves the moment a person checks a parcel in (stock.ts). Shopify only
 * learns of the return from here, and what it needs depends on what Shopify believes about the
 * order, read live at the time:
 *
 * | Shopify order                    | Checked in restocked                    | Checked in damaged                                  |
 * |----------------------------------|-----------------------------------------|-----------------------------------------------------|
 * | Open, not fulfilled (the usual: the team books in PostEx and never fulfils in Shopify) | cancel it, restocking its items: they stop being "committed" and are available again | cancel it, restocking, then take the units off available as damaged |
 * | Fulfilled (Shopify took the units off on fulfilment) | add the units back to available | nothing: they already left Shopify's stock |
 * | Already cancelled, or restocked  | nothing: Shopify already settled it    | nothing                                             |
 *
 * Cancelling never refunds and never emails the customer: a refused COD parcel was never paid for.
 * Each step is sent with an idempotency key (required for inventory changes from 2026-04), and
 * what Shopify accepted is kept, so a retry after a failure does only what is left.
 *
 * Shopify refuses all of it until the app holds `write_orders` (cancel) and `write_inventory`
 * (restock, damaged). The attempt is still recorded, as failed with Shopify's reason, and can be
 * retried once the scope is granted.
 */

export type WritebackOutcome = 'done' | 'skipped' | 'failed';
export type WritebackAction = 'cancel_restock' | 'restock' | 'write_off' | 'none';
type Step = 'cancel' | 'restock' | 'write_off';

export interface ShopifyOrderFacts {
  name: string;
  cancelled: boolean;
  /** `displayFulfillmentStatus`: UNFULFILLED, FULFILLED, PARTIALLY_FULFILLED, RESTOCKED, … */
  fulfillment: string;
  /** Where a fulfilment was sent from, when there is one. */
  locationGid: string | null;
}

export interface InventoryChange {
  inventoryItemGid: string;
  locationGid: string;
  delta: number;
}

/** The calls the write-back makes. The default calls the real stores; tests pass their own. */
export interface ShopifyReturnsGateway {
  order(store: string, shopifyOrderId: string): Promise<ShopifyOrderFacts | null>;
  cancel(store: string, shopifyOrderId: string, staffNote: string): Promise<void>;
  /** Shopify variant id → inventory item gid. */
  inventoryItems(store: string, shopifyVariantIds: readonly string[]): Promise<Map<string, string>>;
  adjust(store: string, input: { reason: 'restock' | 'damaged'; key: string; reference: string; changes: InventoryChange[] }): Promise<void>;
}

const userErrors = (errors: Array<{ message: string }> | undefined): void => {
  if (errors && errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '));
};

export const liveReturnsGateway: ShopifyReturnsGateway = {
  order: async (store, shopifyOrderId) => {
    const data = await shopifyClient(store).graphql<{
      order: { name: string; cancelledAt: string | null; displayFulfillmentStatus: string; fulfillments: Array<{ location: { id: string } | null }> } | null;
    }>(
      `query ReturnOrder($id: ID!) { order(id: $id) { name cancelledAt displayFulfillmentStatus fulfillments(first: 5) { location { id } } } }`,
      { id: `gid://shopify/Order/${shopifyOrderId}` },
    );
    if (!data.order) return null;
    return {
      name: data.order.name,
      cancelled: data.order.cancelledAt !== null,
      fulfillment: data.order.displayFulfillmentStatus,
      locationGid: data.order.fulfillments.find((f) => f.location)?.location?.id ?? null,
    };
  },
  cancel: async (store, shopifyOrderId, staffNote) => {
    const data = await shopifyClient(store).graphql<{ orderCancel: { orderCancelUserErrors: Array<{ message: string }> } }>(
      `mutation ReturnCancel($id: ID!, $note: String) {
        orderCancel(orderId: $id, reason: CUSTOMER, restock: true, notifyCustomer: false, staffNote: $note) { orderCancelUserErrors { field message code } }
      }`,
      { id: `gid://shopify/Order/${shopifyOrderId}`, note: staffNote.slice(0, 255) },
    );
    userErrors(data.orderCancel.orderCancelUserErrors);
  },
  inventoryItems: async (store, shopifyVariantIds) => {
    if (shopifyVariantIds.length === 0) return new Map();
    const data = await shopifyClient(store).graphql<{ nodes: Array<{ id: string; inventoryItem: { id: string } } | null> }>(
      `query ReturnItems($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id inventoryItem { id } } } }`,
      { ids: shopifyVariantIds.map((id) => `gid://shopify/ProductVariant/${id}`) },
    );
    const items = new Map<string, string>();
    for (const node of data.nodes) if (node?.inventoryItem) items.set(node.id.replace('gid://shopify/ProductVariant/', ''), node.inventoryItem.id);
    return items;
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

export interface WritebackState {
  outcome: WritebackOutcome;
  action: WritebackAction;
  /** A sentence for the screen: what Shopify now shows, or why nothing was done. */
  message: string;
  error: string | null;
  at: Date;
}

interface CheckInFacts {
  check_in_id: string;
  outcome: 'restocked' | 'damaged';
  tracking_number: string;
  order_id: string | null;
  order_number: string | null;
  shopify_order_id: string | null;
  store: string | null;
  store_id: string | null;
}

const latestRows = async (db: Db, checkInId: string) =>
  db<{ outcome: WritebackOutcome; action: WritebackAction; detail: { steps?: Step[]; message?: string }; error: string | null; at: Date }[]>`
    select outcome, action, detail, error, at from shopify_writebacks where check_in_id = ${checkInId} order by at desc, id desc
  `;

/** Where one check-in stands in Shopify: its latest attempt, or null when none was made. */
export const writebackState = async (db: Db, checkInId: string): Promise<WritebackState | null> => {
  const [row] = await latestRows(db, checkInId);
  return row ? { outcome: row.outcome, action: row.action, message: row.detail.message ?? '', error: row.error, at: row.at } : null;
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

/**
 * Brings Shopify in line with one return check-in, and records the attempt. Safe to call again:
 * steps Shopify already accepted are not repeated. Never throws for a Shopify refusal; the
 * attempt is recorded as failed and returned.
 */
export const syncCheckInToShopify = async (
  sql: Sql,
  input: { checkInId: string; actorId: string | null; gateway?: ShopifyReturnsGateway; force?: boolean },
): Promise<WritebackState> => {
  const gateway = input.gateway ?? liveReturnsGateway;
  const [facts] = await sql<CheckInFacts[]>`
    select c.id as check_in_id, c.outcome, s.tracking_number, o.id as order_id, o.order_number, o.shopify_order_id::text, st.key as store, st.id as store_id
    from return_check_ins c
    join shipments s on s.id = c.shipment_id
    left join orders o on o.id = s.order_id
    left join stores st on st.id = o.store_id
    where c.id = ${input.checkInId}
  `;
  if (!facts) throw new Error(`Check-in ${input.checkInId} not found`);

  const record = async (outcome: WritebackOutcome, action: WritebackAction, message: string, detail: Record<string, unknown> = {}, error: string | null = null): Promise<WritebackState> => {
    const [row] = await sql<{ at: Date }[]>`
      insert into shopify_writebacks (check_in_id, store_id, outcome, action, detail, error, actor_id)
      values (${facts.check_in_id}, ${facts.store_id}, ${outcome}, ${action}, ${sql.json({ ...detail, message } as never)}, ${error}, ${input.actorId})
      returning at
    `;
    return { outcome, action, message, error, at: row!.at };
  };

  if (!input.force && !(await returnsWritebackEnabled(sql))) return record('skipped', 'none', 'Updating Shopify on check-in is switched off in Settings.');
  if (!facts.order_id || !facts.shopify_order_id || !facts.store) {
    return record('skipped', 'none', 'This parcel has no Shopify order, so there is nothing to update in Shopify.');
  }

  const previous = await latestRows(sql, facts.check_in_id);
  if (previous[0]?.outcome === 'done') return { outcome: 'done', action: previous[0].action, message: previous[0].detail.message ?? '', error: null, at: previous[0].at };
  const done = new Set<Step>(previous.flatMap((r) => r.detail.steps ?? []));

  // What came back: the units this check-in moved, per Shopify variant, and where Shopify keeps them.
  const units = await sql<{ shopify_variant_id: string; qty: number; location_gid: string | null }[]>`
    select v.shopify_variant_id::text, sum(m.qty)::int as qty,
           (select l.location_gid from shopify_stock_levels l where l.variant_id = v.id order by l.on_hand desc limit 1) as location_gid
    from stock_moves m join variants v on v.id = m.variant_id
    where m.ref_type = 'return_check_in' and m.ref_id = ${facts.check_in_id}
    group by v.id, v.shopify_variant_id
  `;
  const unitList = units.map((u) => ({ variant: u.shopify_variant_id, qty: u.qty }));
  const steps: Step[] = [...done];
  const detail = () => ({ order: facts.order_number, units: unitList, steps });

  try {
    const order = await gateway.order(facts.store, facts.shopify_order_id);
    if (!order) return record('failed', 'none', `${facts.order_number} was not found in Shopify.`, detail(), 'order not found');
    if ((order.cancelled || order.fulfillment === 'RESTOCKED') && !done.has('cancel')) {
      return record('skipped', 'none', `${order.name} is already ${order.cancelled ? 'cancelled' : 'restocked'} in Shopify, so its stock is already settled there.`, detail());
    }

    const fulfilled = !done.has('cancel') && (order.fulfillment === 'FULFILLED' || order.fulfillment === 'PARTIALLY_FULFILLED');
    const changes = async (sign: 1 | -1): Promise<InventoryChange[]> => {
      const items = await gateway.inventoryItems(facts.store!, units.map((u) => u.shopify_variant_id));
      return units.map((u) => {
        const item = items.get(u.shopify_variant_id);
        const location = u.location_gid ?? order.locationGid;
        if (!item || !location) throw new Error(`Shopify has no stock record for variant ${u.shopify_variant_id}`);
        return { inventoryItemGid: item, locationGid: location, delta: sign * u.qty };
      });
    };
    const reference = `logistics://nur-platform/return-check-in/${facts.check_in_id}`;
    const key = (step: Step) => `nur-return-check-in-${facts.check_in_id}-${step}`;

    if (fulfilled) {
      if (facts.outcome === 'damaged') {
        return record('done', 'none', `${order.name} was fulfilled in Shopify, so the damaged units had already left its stock. Nothing to change.`, detail());
      }
      if (units.length === 0) return record('skipped', 'none', 'No units of this parcel are mapped to a Shopify product, so none could be restocked.', detail());
      if (!done.has('restock')) {
        await gateway.adjust(facts.store, { reason: 'restock', key: key('restock'), reference, changes: await changes(1) });
        steps.push('restock');
      }
      return record('done', 'restock', `${units.reduce((n, u) => n + u.qty, 0)} units added back to available in Shopify (${order.name} stays fulfilled).`, detail());
    }

    // Open in Shopify: the units are still "committed" to it. Cancelling with restock frees them.
    if (!done.has('cancel')) {
      await gateway.cancel(facts.store, facts.shopify_order_id, `Returned by PostEx (${facts.tracking_number}); checked in as ${facts.outcome} on the NUR platform.`);
      steps.push('cancel');
    }
    if (facts.outcome === 'damaged' && units.length > 0 && !done.has('write_off')) {
      await gateway.adjust(facts.store, { reason: 'damaged', key: key('write_off'), reference, changes: await changes(-1) });
      steps.push('write_off');
    }
    return facts.outcome === 'damaged'
      ? record('done', 'write_off', `${order.name} cancelled in Shopify; its damaged units were taken off available stock.`, detail())
      : record('done', 'cancel_restock', `${order.name} cancelled in Shopify with its items restocked (no refund, customer not notified).`, detail());
  } catch (error) {
    const message = friendly(error);
    logger.warn({ checkInId: facts.check_in_id, store: facts.store, err: message }, 'Return not carried to Shopify');
    return record('failed', steps.includes('cancel') ? 'cancel_restock' : 'none', `Shopify was not updated: ${message}`, detail(), message);
  }
};
