import type { Paisa } from '../lib/money.js';
import { formatKarachi, parsePostexLocal } from '../lib/time.js';
import type { ConfirmationState } from './order-state.js';

/**
 * The Confirmation Desk's rules (Step 11), pure: what an order's confirmation is, given the
 * attempts agents recorded on it. Nothing here reads the clock; every time comes from an attempt
 * or from the caller, so the same attempts always give the same confirmation.
 *
 * | Outcome        | Means                                              | State after                         | Next attempt                     |
 * |----------------|----------------------------------------------------|-------------------------------------|----------------------------------|
 * | `confirmed`    | the customer confirmed the order as placed          | `confirmed`                         | none                             |
 * | `changed`      | confirmed with a change (address, item, quantity)   | `changed`                           | none                             |
 * | `cancelled`    | the customer cancelled                              | `cancelled`                         | none                             |
 * | `no_answer`    | no reply on WhatsApp, or the call was not picked up | `no_answer`; `unreachable` at the Nth | after the retry delay, in desk hours |
 * | `callback`     | reached; the customer asked to be contacted later   | `pending`, unanswered count reset   | the customer's time              |
 * | `wrong_number` | the number is wrong, switched off, or not theirs    | `unreachable`                       | none                             |
 * | `rescheduled`  | a follow-up the agent set without contacting anyone | unchanged (`unreachable` reopens as `no_answer`) | the agent's time      |
 *
 * Only the last decision counts: a customer who confirmed and later calls to cancel is cancelled.
 */

export const ATTEMPT_OUTCOMES = ['confirmed', 'changed', 'cancelled', 'no_answer', 'callback', 'wrong_number', 'rescheduled'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];
export const CHANNELS = ['whatsapp', 'call'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface DeskSettings {
  /** Unanswered attempts after which an order is unreachable. */
  maxAttempts: number;
  /** Minutes to wait after the first, second, … unanswered attempt; the last value repeats. */
  retryMinutes: number[];
  /** Karachi wall-clock hours the desk works (`"10:00"`–`"22:00"`). A retry due outside them waits for the next opening. */
  deskHours: { open: string; close: string };
  /** The click-to-chat message per brand, with `{placeholders}` (see `TEMPLATE_FIELDS`). */
  whatsappTemplates: { nur: string; organics: string };
}

const DEFAULT_TEMPLATE =
  'Assalam o Alaikum {firstName}! Thank you for your order {orderNumber} from {store}: {items}. ' +
  'Total {total}, cash on delivery to {city}. Please reply YES to confirm, or tell us what to change.';

export const DEFAULT_DESK_SETTINGS: DeskSettings = {
  maxAttempts: 3,
  retryMinutes: [60, 180],
  deskHours: { open: '10:00', close: '22:00' },
  whatsappTemplates: { nur: DEFAULT_TEMPLATE, organics: DEFAULT_TEMPLATE },
};

export interface AttemptFact {
  id: string;
  agentId: string;
  outcome: AttemptOutcome;
  at: Date;
  followUpAt: Date | null;
  reason: string | null;
}

export interface DerivedConfirmation {
  state: ConfirmationState;
  source: 'desk' | 'shopify_tags' | 'none';
  agentId: string | null;
  /** Contacts made; a follow-up scheduled without one does not count. */
  attempts: number;
  nextAttemptAt: Date | null;
  outcomeReason: string | null;
  confirmedAt: Date | null;
  lastAttemptAt: Date | null;
}

const OPEN: ReadonlySet<ConfirmationState> = new Set(['pending', 'no_answer']);
export const DECIDED: ReadonlySet<ConfirmationState> = new Set(['confirmed', 'changed', 'cancelled']);

const nextDay = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** `at`, or the desk's next opening when `at` falls outside its hours (Karachi time). */
export const inDeskHours = (at: Date, hours: DeskSettings['deskHours']): Date => {
  const local = formatKarachi(at);
  const day = local.slice(0, 10);
  const time = local.slice(11, 16);
  if (time < hours.open) return parsePostexLocal(`${day} ${hours.open}:00`);
  if (time >= hours.close) return parsePostexLocal(`${nextDay(day)} ${hours.open}:00`);
  return at;
};

/** Attempts in the order they happened; ties keep the order they were recorded in. */
const chronological = (attempts: readonly AttemptFact[]): AttemptFact[] =>
  [...attempts].sort((a, b) => a.at.getTime() - b.at.getTime() || Number(a.id) - Number(b.id));

/**
 * The confirmation an order's attempts add up to. With no attempts yet, the Shopify tags decide
 * (S7), and an open order is due as soon as the desk is open after it was placed.
 */
export const deriveConfirmation = (input: {
  placedAt: Date;
  attempts: readonly AttemptFact[];
  fromTags: ConfirmationState | null;
  settings: DeskSettings;
}): DerivedConfirmation => {
  const { settings } = input;
  if (input.attempts.length === 0) {
    const state = input.fromTags ?? 'pending';
    return {
      state,
      source: input.fromTags ? 'shopify_tags' : 'none',
      agentId: null,
      attempts: 0,
      nextAttemptAt: OPEN.has(state) ? inDeskHours(input.placedAt, settings.deskHours) : null,
      outcomeReason: null,
      confirmedAt: null,
      lastAttemptAt: null,
    };
  }

  let state: ConfirmationState = 'pending';
  let next: Date | null = inDeskHours(input.placedAt, settings.deskHours);
  let reason: string | null = null;
  let confirmedAt: Date | null = null;
  let lastAttemptAt: Date | null = null;
  let agentId: string | null = null;
  let contacts = 0;
  let unanswered = 0;

  for (const attempt of chronological(input.attempts)) {
    agentId = attempt.agentId;
    if (attempt.outcome !== 'rescheduled') {
      contacts++;
      lastAttemptAt = attempt.at;
    }
    switch (attempt.outcome) {
      case 'confirmed':
      case 'changed':
        [state, next, reason, confirmedAt, unanswered] = [attempt.outcome, null, attempt.reason, attempt.at, 0];
        break;
      case 'cancelled':
        [state, next, reason, confirmedAt] = ['cancelled', null, attempt.reason, null];
        break;
      case 'no_answer': {
        unanswered++;
        if (unanswered >= settings.maxAttempts) {
          [state, next, reason] = ['unreachable', null, `No answer after ${unanswered} attempts`];
        } else {
          const minutes = settings.retryMinutes[Math.min(unanswered, settings.retryMinutes.length) - 1] ?? 60;
          [state, next, reason] = ['no_answer', inDeskHours(new Date(attempt.at.getTime() + minutes * 60_000), settings.deskHours), null];
        }
        break;
      }
      case 'callback':
        [state, next, reason, unanswered] = ['pending', attempt.followUpAt, attempt.reason, 0];
        break;
      case 'wrong_number':
        [state, next, reason] = ['unreachable', null, attempt.reason ?? 'Wrong or switched-off number'];
        break;
      case 'rescheduled':
        if (state === 'unreachable') state = 'no_answer';
        next = attempt.followUpAt;
        break;
    }
  }
  return { state, source: 'desk', agentId, attempts: contacts, nextAttemptAt: next, outcomeReason: reason, confirmedAt, lastAttemptAt };
};

/**
 * Why an outcome cannot be recorded on a confirmation in this state, or null when it can. Once the
 * customer has decided, only another decision is news; a no-answer after a confirmation is not.
 * Once a parcel is booked, only a cancellation or a change matters, and both raise an alert.
 */
export const refusal = (current: ConfirmationState, outcome: AttemptOutcome, booked: boolean): string | null => {
  const decision = outcome === 'confirmed' || outcome === 'changed' || outcome === 'cancelled';
  if (booked && outcome !== 'cancelled' && outcome !== 'changed') return 'A parcel is already booked: only a cancellation or a change can be recorded';
  if (DECIDED.has(current) && !decision) return `The customer already decided (${current}); record their new decision instead`;
  return null;
};

// ---- WhatsApp click-to-chat ----

/** What a template can say. Anything else in `{braces}` is refused when the template is saved. */
export const TEMPLATE_FIELDS = ['name', 'firstName', 'orderNumber', 'total', 'items', 'city', 'store'] as const;
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

/** The `{placeholders}` in a template that are not fields. */
export const unknownFields = (template: string): string[] =>
  [...new Set([...template.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!))].filter((f) => !(TEMPLATE_FIELDS as readonly string[]).includes(f));

export const renderTemplate = (template: string, values: Record<TemplateField, string>): string =>
  template.replace(/\{([^{}]*)\}/g, (match, field: string) => (Object.hasOwn(values, field) ? values[field as TemplateField] : match));

/** `Rs 2,750` or `Rs 2,750.50`, from paisa, without floating point (rule 3). */
export const formatRupees = (amount: Paisa): string => {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const rupees = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = abs % 100n;
  return `${negative ? '-' : ''}Rs ${rupees}${rest === 0n ? '' : `.${rest.toString().padStart(2, '0')}`}`;
};

/**
 * A WhatsApp click-to-chat link: opens a chat with the customer, the message typed in, from
 * whichever WhatsApp the agent is signed in to. Only a link; nothing is sent by the platform.
 */
export const whatsappLink = (phoneE164: string, message: string): string =>
  `https://wa.me/${phoneE164.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`;

export const callLink = (phoneE164: string): string => `tel:${phoneE164}`;
