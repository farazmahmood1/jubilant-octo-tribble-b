import { type AttemptFact, DEFAULT_DESK_SETTINGS, type DerivedConfirmation, type DeskSettings, deriveConfirmation } from '../../domain/confirmation.js';
import type { ConfirmationState } from '../../domain/order-state.js';
import { type Db, atomically } from './upsert.js';

/**
 * Each online order's confirmation (Step 11), as the Confirmation Desk's attempts make it, or
 * before the desk's first attempt, as the team's Shopify tags make it (3.2 note S7). Written only
 * by `recomputeConfirmation`, which the order state recompute calls first, so a confirmation and
 * the order state it decides never disagree (rule 7).
 */

/**
 * `app_settings` key `confirmation_tags`: which Shopify tags mean which desk outcome. Tags are
 * compared by their words only, so `✅ Order Confirmed`, `order confirmed` and
 * `Order  Confirmed!` are the same tag.
 */
export interface ConfirmationTags {
  confirmed: string[];
  cancelled: string[];
  pending: string[];
  noAnswer: string[];
  unreachable: string[];
}

/**
 * The tags both teams use today (Shopify admin, October 2026). Juggun's Organics also has the
 * `COD-Confirmed` / `COD-Needs-Review` pair, which NUR by Juggun does not.
 */
export const DEFAULT_CONFIRMATION_TAGS: ConfirmationTags = {
  confirmed: ['Order Confirmed', 'COD-Confirmed'],
  cancelled: ['Order Canceled', 'Order Cancelled'],
  pending: ['Confirmation Pending', 'COD-Needs-Review'],
  noAnswer: ['didnt answer the call', 'call not attended', 'didnt confirm'],
  unreachable: ['number off', 'No Phone', 'NO WhatsApp'],
};

export const confirmationTags = async (db: Db): Promise<ConfirmationTags> => {
  const [row] = await db<{ value: Partial<ConfirmationTags> }[]>`select value from app_settings where key = 'confirmation_tags'`;
  return { ...DEFAULT_CONFIRMATION_TAGS, ...(row?.value ?? {}) };
};

/** A tag's words, lowercased: emoji, symbols and spacing are how a tag looks, not what it says. */
export const tagWords = (tag: string): string =>
  tag
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const hasTag = (tags: readonly string[], wanted: readonly string[]): boolean => {
  const present = new Set(tags.map(tagWords));
  return wanted.some((w) => present.has(tagWords(w)));
};

/**
 * The desk outcome the tags say, strongest first: a cancellation or a confirmation is a decision;
 * the call outcomes only say why there is none yet. Null when no tag speaks to it.
 */
export const confirmationFromTags = (orderTags: readonly string[], map: ConfirmationTags): ConfirmationState | null => {
  if (hasTag(orderTags, map.cancelled)) return 'cancelled';
  if (hasTag(orderTags, map.confirmed)) return 'confirmed';
  if (hasTag(orderTags, map.unreachable)) return 'unreachable';
  if (hasTag(orderTags, map.noAnswer)) return 'no_answer';
  if (hasTag(orderTags, map.pending)) return 'pending';
  return null;
};

/** `app_settings` key `confirmation_desk`, over the defaults; a partial setting keeps the rest. */
export const deskSettings = async (db: Db): Promise<DeskSettings> => {
  const [row] = await db<{ value: Partial<DeskSettings> }[]>`select value from app_settings where key = 'confirmation_desk'`;
  const value = row?.value ?? {};
  return {
    ...DEFAULT_DESK_SETTINGS,
    ...value,
    deskHours: { ...DEFAULT_DESK_SETTINGS.deskHours, ...(value.deskHours ?? {}) },
    whatsappTemplates: { ...DEFAULT_DESK_SETTINGS.whatsappTemplates, ...(value.whatsappTemplates ?? {}) },
  };
};

/**
 * Recomputes one order's confirmation and stores it. Null for an order the desk never confirms:
 * PR packages and consignment sales. Safe to run any number of times.
 */
export const recomputeConfirmation = async (db: Db, orderId: string): Promise<DerivedConfirmation | null> =>
  atomically(db, async (tx) => {
    const [order] = await tx<{ channel: string; placed_at: Date; tags: string[] }[]>`
      select channel, placed_at, tags from orders where id = ${orderId}
    `;
    if (!order || order.channel !== 'online') return null;
    const attempts = await tx<{ id: string; agent_id: string; outcome: AttemptFact['outcome']; at: Date; follow_up_at: Date | null; reason: string | null }[]>`
      select a.id, a.agent_id, a.outcome, a.at, a.follow_up_at, a.reason
      from confirmation_attempts a join confirmations c on c.id = a.confirmation_id
      where c.order_id = ${orderId}
    `;
    const derived = deriveConfirmation({
      placedAt: order.placed_at,
      attempts: attempts.map((a) => ({ id: a.id, agentId: a.agent_id, outcome: a.outcome, at: a.at, followUpAt: a.follow_up_at, reason: a.reason })),
      fromTags: confirmationFromTags(order.tags, await confirmationTags(tx)),
      settings: await deskSettings(tx),
    });
    await tx`
      insert into confirmations (order_id, state, source, agent_id, attempts, next_attempt_at, outcome_reason, confirmed_at, last_attempt_at)
      values (${orderId}, ${derived.state}, ${derived.source}, ${derived.agentId}, ${derived.attempts}, ${derived.nextAttemptAt},
              ${derived.outcomeReason}, ${derived.confirmedAt}, ${derived.lastAttemptAt})
      on conflict (order_id) do update set
        state = excluded.state, source = excluded.source, agent_id = excluded.agent_id, attempts = excluded.attempts,
        next_attempt_at = excluded.next_attempt_at, outcome_reason = excluded.outcome_reason,
        confirmed_at = excluded.confirmed_at, last_attempt_at = excluded.last_attempt_at
    `;
    return derived;
  });
