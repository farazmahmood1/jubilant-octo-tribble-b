import { tagWords } from '../db/repos/confirmations.js';
import { recomputeOrderState } from '../db/repos/order-state.js';
import type { Db } from '../db/repos/upsert.js';
import { logger } from '../logger.js';

/**
 * Shopify's order tags are where the team says where an order stands: the WhatsApp automation tags
 * it, and people tag it in Shopify or from the Confirmations page. Both sides must say the same
 * thing, so the page shows the order's Shopify tags and changes them in Shopify, never a status of
 * its own.
 */

export type StoreKey = 'nur' | 'organics';

/**
 * The tags that say where an order stands, per store, spelled exactly as they are in Shopify
 * (October 2026): the ones the page offers. Tags other apps add (Loox, Quoli, `releasit_cod_form`,
 * `⚠ Subscription Required` from the WhatsApp automation) say nothing about the order's
 * confirmation, so they are shown but never offered, and do not stop an order being new.
 */
export const STATUS_TAGS: Record<StoreKey, readonly string[]> = {
  nur: [
    '✅ Order Confirmed',
    '⚠ Confirmation Pending',
    '❌ Order Canceled',
    'by call',
    'didnt answer the call',
    'call not attended',
    'didnt confirm',
    'number off',
    'location issue',
    '⚠ NO WhatsApp',
    '⚠ No Phone',
  ],
  organics: [
    '✅ Order Confirmed',
    'COD-Confirmed',
    '⚠ Confirmation Pending',
    'COD-Needs-Review',
    '❌ Order Canceled',
    'by call',
    'didnt confirm',
    'number off',
    '⚠ NO WhatsApp',
    '⚠ No Phone',
  ],
};

/** What the PostEx app tags an order with when it is booked ("Book at PostEx"): it has left the desk. */
export const BOOKED_TAG = 'PostEx';

/** Every status tag of either brand, by its words: an order carrying any of them is no longer new. */
export const STATUS_TAG_WORDS: readonly string[] = [...new Set([...STATUS_TAGS.nur, ...STATUS_TAGS.organics].map(tagWords))];

export const statusTagsFor = (store: string): readonly string[] => (store === 'nur' || store === 'organics' ? STATUS_TAGS[store] : []);

export class TagError extends Error {
  readonly status: 400 | 404 | 409 | 502;
  constructor(message: string, status: 400 | 404 | 409 | 502 = 409) {
    super(message);
    this.name = 'TagError';
    this.status = status;
  }
}

/** Adds and removes tags on the Shopify order, leaving every other tag alone. */
export type TagWriter = (store: string, shopifyOrderId: string, add: string[], remove: string[]) => Promise<void>;

export interface TagEditResult {
  /** unchanged: the order already said it, and Shopify was not called. */
  status: 'written' | 'unchanged';
  add: string[];
  remove: string[];
  tags: string[];
}

/**
 * Changes an order's status tags in Shopify first, then here: Shopify is the record, so a write it
 * refuses changes nothing on either side and is reported, not hidden. Only status tags are added or
 * removed; a tag another app put on the order is not this page's to take off.
 *
 * `refresh` reads the order back from Shopify after the write, so a tag someone changed in Shopify
 * since the last sync is here too. If it fails, the copy kept here is the old tags plus this change,
 * which is what Shopify now holds for these tags, and the next sync corrects the rest.
 */
export const editOrderTags = async (
  db: Db,
  input: { orderId: string; actorId: string; add: readonly string[]; remove: readonly string[]; write: TagWriter; refresh?: (orderId: string) => Promise<void> },
): Promise<TagEditResult> => {
  const [order] = await db<{ store: string; shopify_order_id: string | null; channel: string; tags: string[] }[]>`
    select st.key as store, o.shopify_order_id::text, o.channel, o.tags from orders o join stores st on st.id = o.store_id where o.id = ${input.orderId}
  `;
  if (!order) throw new TagError(`Order ${input.orderId} not found`, 404);
  if (order.channel !== 'online') throw new TagError(`A ${order.channel} order has no confirmation tags`);
  if (!order.shopify_order_id) throw new TagError('This order is not in Shopify, so it has no tags to change');

  const vocabulary = statusTagsFor(order.store);
  const add: string[] = [];
  for (const wanted of input.add) {
    const tag = vocabulary.find((t) => tagWords(t) === tagWords(wanted));
    if (!tag) throw new TagError(`"${wanted}" is not one of this store's status tags`, 400);
    if (!order.tags.some((t) => tagWords(t) === tagWords(tag)) && !add.includes(tag)) add.push(tag);
  }
  const remove: string[] = [];
  for (const unwanted of input.remove) {
    if (!STATUS_TAG_WORDS.includes(tagWords(unwanted))) throw new TagError(`"${unwanted}" is not a status tag, so it is not removed from here`, 400);
    // The order's own spelling: Shopify removes a tag only by its exact text.
    for (const t of order.tags) if (tagWords(t) === tagWords(unwanted) && !remove.includes(t)) remove.push(t);
  }
  if (add.some((a) => remove.some((r) => tagWords(a) === tagWords(r)))) throw new TagError('The same tag cannot be added and removed at once', 400);
  if (add.length === 0 && remove.length === 0) return { status: 'unchanged', add, remove, tags: order.tags };

  try {
    await input.write(order.store, order.shopify_order_id, add, remove);
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'Shopify refused the change';
    logger.warn({ orderId: input.orderId, store: order.store, error }, 'Shopify tags not changed');
    await db`
      insert into audit_log (actor_id, action, entity, entity_id, after)
      values (${input.actorId}, 'shopify.tags.failed', 'orders', ${input.orderId}, ${db.json({ add, remove, error })})
    `;
    throw new TagError(`Shopify did not save the change: ${error}`, 502);
  }

  await db`update orders set tags = ${[...order.tags.filter((t) => !remove.includes(t)), ...add]}::text[] where id = ${input.orderId}`;
  if (input.refresh) {
    await input.refresh(input.orderId).catch((error: unknown) => logger.warn({ orderId: input.orderId, err: error }, 'Order not read back from Shopify after a tag change'));
  }
  await recomputeOrderState(db, input.orderId);
  await db`
    insert into audit_log (actor_id, action, entity, entity_id, before, after)
    values (${input.actorId}, 'shopify.tags', 'orders', ${input.orderId}, ${db.json({ tags: order.tags })}, ${db.json({ add, remove })})
  `;
  const [now] = await db<{ tags: string[] }[]>`select tags from orders where id = ${input.orderId}`;
  return { status: 'written', add, remove, tags: now!.tags };
};

// ---- Timeline ----

/** One event on Shopify's order timeline, as the Admin API returns it. */
export interface ShopifyEvent {
  createdAt: string;
  action: string;
  message: string;
  appTitle: string | null;
  attributeToApp: boolean;
}

export interface TimelineEntry {
  at: Date;
  /** shopify: on Shopify's timeline; platform: done here, which Shopify's timeline does not show. */
  source: 'shopify' | 'platform';
  /** The app or the person, when known. */
  who: string | null;
  text: string;
}

/** Bookkeeping Shopify records but leaves off the timeline it shows the merchant. */
const HIDDEN_ACTIONS: ReadonlySet<string> = new Set(['tax_finalization_capture_started', 'confirmed']);

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** A Shopify event message is HTML (`order <a href="…">#64670</a>`); the timeline here is text. */
export const plainMessage = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();

const list = (tags: unknown): string => (Array.isArray(tags) ? tags.map(String).join(', ') : '');

/** What a platform audit entry says on the timeline, or null for one that is not shown there. */
export const describeAudit = (action: string, after: Record<string, unknown> | null): string | null => {
  if (action === 'shopify.tags' || action === 'shopify.confirmation_tags') {
    const parts = [list(after?.['add']) && `added ${list(after?.['add'])}`, list(after?.['remove']) && `removed ${list(after?.['remove'])}`].filter(Boolean);
    return parts.length > 0 ? `Tags ${parts.join('; ')}` : null;
  }
  if (action === 'shopify.tags.failed') return `Tag change not saved in Shopify: ${String(after?.['error'] ?? 'refused')}`;
  // Call outcomes the platform recorded itself before the tags became the record.
  if (action.startsWith('confirmation.')) return `Recorded "${action.slice('confirmation.'.length).replaceAll('_', ' ')}" (old confirmation desk)`;
  return null;
};

/**
 * The order's timeline, newest first: Shopify's own (passed in, fetched live) merged with what was
 * done here. Shopify does not log tag changes on its timeline, so the platform's tag changes are
 * shown from its audit log, with who made them.
 */
export const orderTimeline = async (db: Db, orderId: string, shopify: readonly ShopifyEvent[]): Promise<TimelineEntry[]> => {
  const audits = await db<{ at: Date; action: string; after: Record<string, unknown> | null; who: string | null }[]>`
    select a.at, a.action, a.after, u.name as who
    from audit_log a left join users u on u.id = a.actor_id
    where a.entity = 'orders' and a.entity_id = ${orderId}
      and (a.action like 'shopify.%' or a.action like 'confirmation.%')
  `;
  const entries: TimelineEntry[] = [
    ...shopify
      .filter((e) => !HIDDEN_ACTIONS.has(e.action))
      .map((e) => ({ at: new Date(e.createdAt), source: 'shopify' as const, who: e.attributeToApp ? e.appTitle : null, text: plainMessage(e.message) })),
    ...audits.flatMap((a) => {
      const text = describeAudit(a.action, a.after);
      return text ? [{ at: a.at, source: 'platform' as const, who: a.who, text }] : [];
    }),
  ];
  return entries.sort((x, y) => y.at.getTime() - x.at.getTime());
};
