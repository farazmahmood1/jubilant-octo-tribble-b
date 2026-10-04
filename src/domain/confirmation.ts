import type { Paisa } from '../lib/money.js';
import type { ConfirmationState } from './order-state.js';

/**
 * An order's confirmation is what its Shopify tags say (3.2 note S7), and nothing else. Customers
 * confirm on WhatsApp, where the store's automation tags the order; the team tags the rest, in
 * Shopify or from the Confirmations page, which writes the same tag to Shopify. So the tags are the
 * one record of it, and the platform keeps no outcome of its own that could disagree with Shopify.
 */
export interface DerivedConfirmation {
  state: ConfirmationState;
  /** `none`: no tag says anything about the confirmation yet. */
  source: 'shopify_tags' | 'none';
}

export const confirmationOf = (fromTags: ConfirmationState | null): DerivedConfirmation => ({
  state: fromTags ?? 'pending',
  source: fromTags ? 'shopify_tags' : 'none',
});

/** `Rs 2,750` or `Rs 2,750.50`, from paisa, without floating point (rule 3). */
export const formatRupees = (amount: Paisa): string => {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const rupees = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = abs % 100n;
  return `${negative ? '-' : ''}Rs ${rupees}${rest === 0n ? '' : `.${rest.toString().padStart(2, '0')}`}`;
};

/**
 * A WhatsApp click-to-chat link: opens a chat with the customer from whichever WhatsApp the person
 * is signed in to. Only a link; nothing is sent by the platform.
 */
export const whatsappLink = (phoneE164: string): string => `https://wa.me/${phoneE164.replace(/^\+/, '')}`;

export const callLink = (phoneE164: string): string => `tel:${phoneE164}`;
