import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paisa } from '../lib/money.js';
import {
  type AttemptFact,
  type AttemptOutcome,
  DEFAULT_DESK_SETTINGS,
  deriveConfirmation,
  formatRupees,
  inDeskHours,
  refusal,
  renderTemplate,
  unknownFields,
  whatsappLink,
} from './confirmation.js';

/** Karachi is UTC+5: 10:00 Karachi is 05:00Z. */
const PLACED = new Date('2026-09-01T06:00:00Z');
const settings = DEFAULT_DESK_SETTINGS;

let n = 0;
const at = (iso: string, outcome: AttemptOutcome, extra: Partial<AttemptFact> = {}): AttemptFact => ({
  id: String(++n),
  agentId: '7',
  outcome,
  at: new Date(iso),
  followUpAt: null,
  reason: null,
  ...extra,
});
const derive = (attempts: AttemptFact[], fromTags: Parameters<typeof deriveConfirmation>[0]['fromTags'] = null) =>
  deriveConfirmation({ placedAt: PLACED, attempts, fromTags, settings });

describe('confirmation derived from the desk attempts', () => {
  it('no attempts: the Shopify tags decide (S7), and an open order is due when the desk is open', () => {
    assert.deepEqual(
      [derive([]).state, derive([]).source, derive([]).attempts, derive([]).nextAttemptAt?.toISOString()],
      ['pending', 'none', 0, PLACED.toISOString()],
    );
    const tagged = derive([], 'confirmed');
    assert.deepEqual([tagged.state, tagged.source, tagged.nextAttemptAt, tagged.confirmedAt], ['confirmed', 'shopify_tags', null, null]);
    // Placed at 23:30 Karachi: due at 10:00 the next morning.
    const late = deriveConfirmation({ placedAt: new Date('2026-09-01T18:30:00Z'), attempts: [], fromTags: null, settings });
    assert.equal(late.nextAttemptAt?.toISOString(), '2026-09-02T05:00:00.000Z');
  });

  it('NO ANSWER reschedules after the retry delay; the Nth unanswered attempt makes it unreachable', () => {
    const first = at('2026-09-01T06:00:00Z', 'no_answer');
    const one = derive([first]);
    assert.deepEqual([one.state, one.attempts, one.nextAttemptAt?.toISOString()], ['no_answer', 1, '2026-09-01T07:00:00.000Z'], '60 minutes later');
    const second = at('2026-09-01T07:05:00Z', 'no_answer');
    const two = derive([first, second]);
    assert.deepEqual([two.state, two.attempts, two.nextAttemptAt?.toISOString()], ['no_answer', 2, '2026-09-01T10:05:00.000Z'], '180 minutes later');
    const three = derive([first, second, at('2026-09-01T10:10:00Z', 'no_answer')]);
    assert.deepEqual([three.state, three.attempts, three.nextAttemptAt, three.outcomeReason], ['unreachable', 3, null, 'No answer after 3 attempts']);
    // With N = 5 the same three attempts leave it open.
    const five = deriveConfirmation({ placedAt: PLACED, attempts: [first, second, at('2026-09-01T10:10:00Z', 'no_answer')], fromTags: null, settings: { ...settings, maxAttempts: 5 } });
    assert.equal(five.state, 'no_answer');
    assert.equal(five.nextAttemptAt?.toISOString(), '2026-09-01T13:10:00.000Z', 'the last delay repeats');
  });

  it('a retry that would fall after the desk closes waits for the next opening', () => {
    // 21:30 Karachi + 60 minutes is 22:30, after closing: 10:00 the next day.
    const late = derive([at('2026-09-01T16:30:00Z', 'no_answer')]);
    assert.equal(late.nextAttemptAt?.toISOString(), '2026-09-02T05:00:00.000Z');
    assert.equal(inDeskHours(new Date('2026-09-01T03:00:00Z'), settings.deskHours).toISOString(), '2026-09-01T05:00:00.000Z', '08:00 waits for 10:00');
    assert.equal(inDeskHours(new Date('2026-09-01T08:00:00Z'), settings.deskHours).toISOString(), '2026-09-01T08:00:00.000Z', '13:00 is open');
  });

  it('a callback is a contact: due at the customer\'s time, and the unanswered count starts again', () => {
    const tomorrow = new Date('2026-09-02T12:00:00Z');
    const c = derive([at('2026-09-01T06:00:00Z', 'no_answer'), at('2026-09-01T07:00:00Z', 'no_answer'), at('2026-09-01T09:00:00Z', 'callback', { followUpAt: tomorrow })]);
    assert.deepEqual([c.state, c.attempts, c.nextAttemptAt], ['pending', 3, tomorrow]);
    const after = derive([
      at('2026-09-01T06:00:00Z', 'no_answer'),
      at('2026-09-01T07:00:00Z', 'no_answer'),
      at('2026-09-01T09:00:00Z', 'callback', { followUpAt: tomorrow }),
      at('2026-09-02T12:00:00Z', 'no_answer'),
    ]);
    assert.equal(after.state, 'no_answer', 'one unanswered attempt since the callback, not three');
  });

  it('decisions: confirmed, changed and cancelled close it; the last decision wins; a wrong number is unreachable', () => {
    const confirmed = derive([at('2026-09-01T06:00:00Z', 'confirmed')]);
    assert.deepEqual([confirmed.state, confirmed.confirmedAt?.toISOString(), confirmed.nextAttemptAt, confirmed.source], ['confirmed', '2026-09-01T06:00:00.000Z', null, 'desk']);
    const changed = derive([at('2026-09-01T06:00:00Z', 'changed', { reason: 'Second item removed' })]);
    assert.deepEqual([changed.state, changed.outcomeReason], ['changed', 'Second item removed']);
    const regret = derive([at('2026-09-01T06:00:00Z', 'confirmed'), at('2026-09-01T09:00:00Z', 'cancelled', { reason: 'Ordered twice' })]);
    assert.deepEqual([regret.state, regret.confirmedAt, regret.outcomeReason], ['cancelled', null, 'Ordered twice']);
    assert.equal(derive([at('2026-09-01T06:00:00Z', 'wrong_number')]).state, 'unreachable');
    // Recorded out of order: the times decide, not the ids.
    const late = at('2026-09-01T09:00:00Z', 'cancelled', { reason: 'x' });
    const early = at('2026-09-01T06:00:00Z', 'confirmed');
    assert.equal(derive([late, early]).state, 'cancelled');
  });

  it('a follow-up the agent schedules counts no contact, and gives an unreachable order one more try', () => {
    const when = new Date('2026-09-03T06:00:00Z');
    const r = derive([at('2026-09-01T06:00:00Z', 'wrong_number'), at('2026-09-01T07:00:00Z', 'rescheduled', { followUpAt: when })]);
    assert.deepEqual([r.state, r.attempts, r.nextAttemptAt], ['no_answer', 1, when]);
  });

  it('refuses what makes no sense for the order as it stands', () => {
    assert.equal(refusal('pending', 'no_answer', false), null);
    assert.match(String(refusal('confirmed', 'no_answer', false)), /already decided \(confirmed\)/);
    assert.equal(refusal('confirmed', 'cancelled', false), null, 'a customer may change their mind');
    assert.equal(refusal('cancelled', 'confirmed', false), null);
    assert.match(String(refusal('pending', 'confirmed', true)), /parcel is already booked/);
    assert.equal(refusal('confirmed', 'cancelled', true), null, 'cancelling after booking is recorded, and raises the alert');
  });
});

describe('WhatsApp click-to-chat links', () => {
  const values = { name: 'Test Customer', firstName: 'Test', orderNumber: '#1234', total: 'Rs 2,750', items: '2 × Serum', city: 'Lahore', store: 'NUR by Juggun' };

  it('fills the template, leaves an unknown placeholder visible, and reports it', () => {
    assert.equal(renderTemplate('Hi {firstName}, order {orderNumber} for {total}', values), 'Hi Test, order #1234 for Rs 2,750');
    assert.equal(renderTemplate('Hi {nickname}', values), 'Hi {nickname}');
    assert.deepEqual(unknownFields('Hi {nickname}, {orderNumber} {addresss}'), ['nickname', 'addresss']);
    assert.deepEqual(unknownFields(DEFAULT_DESK_SETTINGS.whatsappTemplates.nur), []);
  });

  it('builds a wa.me link with the number in international digits and the message URL-encoded', () => {
    assert.equal(whatsappLink('+923001234567', 'Order #12 & more?'), 'https://wa.me/923001234567?text=Order%20%2312%20%26%20more%3F');
  });

  it('formats paisa as rupees with grouping, without floating point', () => {
    assert.equal(formatRupees(paisa(275_000n)), 'Rs 2,750');
    assert.equal(formatRupees(paisa(123_456_705n)), 'Rs 1,234,567.05');
    assert.equal(formatRupees(paisa(0n)), 'Rs 0');
  });
});
