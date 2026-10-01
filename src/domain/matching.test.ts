import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Paisa, paisa } from '../lib/money.js';
import { parsePostexLocal } from '../lib/time.js';
import {
  type MatchExplanation,
  type MatchOptions,
  type OrderCandidate,
  type ShipmentForMatching,
  explainMatch,
  matchShipment,
  parseOrderRef,
} from './matching.js';

const NUR = '1';
const ORGANICS = '2';
const karachi = parsePostexLocal;
const rs = (rupees: number): Paisa => paisa(BigInt(rupees) * 100n);

/** A parcel booked on the NUR account. Placeholder phone and refs only. */
const parcel = (overrides: Partial<ShipmentForMatching> = {}): ShipmentForMatching => ({
  orderRefNumber: null,
  codAmount: rs(2750),
  city: 'Lahore',
  customerPhone: '+923001234567',
  bookedAt: karachi('2026-06-25 18:00:00'),
  ...overrides,
});

const order = (id: string, overrides: Partial<OrderCandidate> = {}): OrderCandidate => ({
  id,
  storeId: NUR,
  name: '#1234',
  codAmount: rs(2750),
  city: 'Lahore',
  phone: '0300-1234567',
  placedAt: karachi('2026-06-24 11:00:00'),
  ...overrides,
});

/** The same order number, amount, city and customer, but in the other brand's store. */
const organicsTwin = order('o-1234', { storeId: ORGANICS });

const nur: MatchOptions = { storeId: NUR };

const expect = (explanation: MatchExplanation) => explanation;
const matched = (orderId: string, method: 'tracking_note' | 'order_ref' | 'cod_city_window' | 'phone_window', confidence: number) =>
  expect({ match: { orderId, method, confidence }, reason: null, tiedOrderIds: [] });
const unmatched = (reason: MatchExplanation['reason'], tiedOrderIds: string[] = []) =>
  expect({ match: null, reason, tiedOrderIds });

interface Case {
  name: string;
  shipment: ShipmentForMatching;
  candidates: OrderCandidate[];
  options?: MatchOptions;
  expected: MatchExplanation;
}

const TRACKING = '20000000000462';

const cases: Case[] = [
  // Strategy ½: the booking app wrote this parcel's tracking number on the order
  { name: 'the order naming the tracking number wins, even over a ref naming another order', shipment: parcel({ trackingNumber: TRACKING, orderRefNumber: '#1234' }), candidates: [order('n-1234'), order('n-1300', { name: '#1300', trackingNumbers: [TRACKING] })], expected: matched('n-1300', 'tracking_note', 1) },
  { name: 'a typo in the ref does not matter when the order names the parcel', shipment: parcel({ trackingNumber: TRACKING, orderRefNumber: '#99999' }), candidates: [order('n-1234', { trackingNumbers: ['20000000000001', TRACKING] })], expected: matched('n-1234', 'tracking_note', 1) },
  { name: "the other brand's order naming the same number is never a candidate", shipment: parcel({ trackingNumber: TRACKING, orderRefNumber: '#1234' }), candidates: [order('n-1234'), order('o-77', { storeId: ORGANICS, trackingNumbers: [TRACKING] })], expected: matched('n-1234', 'order_ref', 1) },
  { name: 'two orders naming the same tracking number: ambiguous, not a guess', shipment: parcel({ trackingNumber: TRACKING }), candidates: [order('n-1', { trackingNumbers: [TRACKING] }), order('n-2', { trackingNumbers: [TRACKING] })], expected: unmatched('ambiguous', ['n-1', 'n-2']) },
  { name: 'no order names the parcel: the order reference decides as before', shipment: parcel({ trackingNumber: TRACKING, orderRefNumber: '#1234' }), candidates: [order('n-1234', { trackingNumbers: ['20000000000001'] })], expected: matched('n-1234', 'order_ref', 1) },

  // Strategy 1: order reference
  { name: 'ref "#1234" matches the order named #1234', shipment: parcel({ orderRefNumber: '#1234' }), candidates: [order('n-1234')], expected: matched('n-1234', 'order_ref', 1) },
  { name: 'ref "1234" (no #) matches #1234', shipment: parcel({ orderRefNumber: '1234' }), candidates: [order('n-1234')], expected: matched('n-1234', 'order_ref', 1) },
  { name: 'ref "NBJ-1234" matches #1234 when NBJ is this store\'s prefix', shipment: parcel({ orderRefNumber: 'NBJ-1234' }), candidates: [order('n-1234')], options: { storeId: NUR, refPrefixes: ['NBJ'] }, expected: matched('n-1234', 'order_ref', 1) },
  { name: 'ref "nbj 1234" (lower case, space) matches too', shipment: parcel({ orderRefNumber: 'nbj 1234' }), candidates: [order('n-1234')], options: { storeId: NUR, refPrefixes: ['NBJ'] }, expected: matched('n-1234', 'order_ref', 1) },
  { name: 'ref "#01234" ignores the leading zero', shipment: parcel({ orderRefNumber: ' #01234 ' }), candidates: [order('n-1234')], expected: matched('n-1234', 'order_ref', 1) },
  { name: 'an order named "NBJ1234" in Shopify matches ref "#1234"', shipment: parcel({ orderRefNumber: '#1234' }), candidates: [order('n-1234', { name: 'NBJ1234' })], expected: matched('n-1234', 'order_ref', 1) },
  { name: 'ref match wins even when amount and city differ', shipment: parcel({ orderRefNumber: '#1234', codAmount: rs(999), city: 'Quetta' }), candidates: [order('n-1234')], expected: matched('n-1234', 'order_ref', 1) },
  { name: 'a prefix this store does not use is refused, not stripped', shipment: parcel({ orderRefNumber: 'NBJ-1234' }), candidates: [order('n-1234')], expected: unmatched('foreign_ref_prefix') },
  { name: 'a parsed ref with no such order stops: no fallback onto another customer', shipment: parcel({ orderRefNumber: '#9999' }), candidates: [order('n-1234')], expected: unmatched('order_ref_not_found') },

  // Strategy 2: COD + city + window
  { name: 'no ref: same COD, city and window matches', shipment: parcel(), candidates: [order('n-1234')], expected: matched('n-1234', 'cod_city_window', 0.8) },
  { name: 'an unparseable ref ("PR-INF-01") falls through to COD + city', shipment: parcel({ orderRefNumber: 'PR-INF-01' }), candidates: [order('n-1234')], expected: matched('n-1234', 'cod_city_window', 0.8) },
  { name: 'city compares ignoring case and spacing', shipment: parcel({ city: '  LAHORE ' }), candidates: [order('n-1234')], expected: matched('n-1234', 'cod_city_window', 0.8) },
  { name: 'placed exactly 3 Karachi days before booking is inside the window', shipment: parcel(), candidates: [order('n-1234', { placedAt: karachi('2026-06-22 00:05:00') })], expected: matched('n-1234', 'cod_city_window', 0.8) },
  { name: 'a different city does not qualify (phone then decides)', shipment: parcel({ city: 'Karachi' }), candidates: [order('n-1234')], expected: matched('n-1234', 'phone_window', 0.6) },

  // Strategy 3: phone + window
  { name: 'no ref, different COD: same phone in window matches', shipment: parcel({ codAmount: rs(3000) }), candidates: [order('n-1234')], expected: matched('n-1234', 'phone_window', 0.6) },
  { name: 'phones compare after normalising both sides', shipment: parcel({ codAmount: null, customerPhone: '92 300 1234567' }), candidates: [order('n-1234', { phone: '+92 (300) 123-4567' })], expected: matched('n-1234', 'phone_window', 0.6) },
  { name: 'a zero-COD parcel skips the COD strategy and can still match by phone', shipment: parcel({ codAmount: rs(0) }), candidates: [order('n-1234', { codAmount: rs(0) })], expected: matched('n-1234', 'phone_window', 0.6) },

  // Window edges
  { name: 'placed 4 days before booking is outside the default window', shipment: parcel(), candidates: [order('n-1234', { placedAt: karachi('2026-06-21 23:59:00') })], expected: unmatched('no_candidate_matched') },
  { name: 'a wider window option lets it in', shipment: parcel(), candidates: [order('n-1234', { placedAt: karachi('2026-06-21 23:59:00') })], options: { storeId: NUR, windowDays: 5 }, expected: matched('n-1234', 'cod_city_window', 0.8) },
  { name: 'an order placed after the booking never qualifies', shipment: parcel(), candidates: [order('n-1234', { placedAt: karachi('2026-06-26 09:00:00') })], expected: unmatched('no_candidate_matched') },
  { name: 'no booking date: the window strategies cannot run', shipment: parcel({ bookedAt: null }), candidates: [order('n-1234')], expected: unmatched('no_candidate_matched') },

  // No candidates
  { name: 'no candidates, no ref', shipment: parcel(), candidates: [], expected: unmatched('no_candidate_matched') },
  { name: 'no candidates, with a ref', shipment: parcel({ orderRefNumber: '#1234' }), candidates: [], expected: unmatched('order_ref_not_found') },
  { name: 'nothing usable on the parcel at all', shipment: parcel({ codAmount: null, customerPhone: null }), candidates: [order('n-1234')], expected: unmatched('no_candidate_matched') },

  // Ambiguity
  { name: 'two orders with the same COD, city and window: no coin flip', shipment: parcel(), candidates: [order('n-2', { name: '#2' }), order('n-1', { name: '#1' })], expected: unmatched('ambiguous', ['n-1', 'n-2']) },
  { name: 'two orders with the same phone in window: no coin flip', shipment: parcel({ codAmount: rs(1) }), candidates: [order('n-1', { name: '#1' }), order('n-2', { name: '#2', codAmount: rs(500) })], expected: unmatched('ambiguous', ['n-1', 'n-2']) },
  { name: 'an ambiguous COD tie is not broken by the weaker phone strategy', shipment: parcel(), candidates: [order('n-1', { name: '#1' }), order('n-2', { name: '#2', phone: '03111234567' })], expected: unmatched('ambiguous', ['n-1', 'n-2']) },
  { name: 'two orders sharing an order number in one store are ambiguous', shipment: parcel({ orderRefNumber: '#1234' }), candidates: [order('n-a'), order('n-b', { name: 'NBJ-1234' })], expected: unmatched('ambiguous', ['n-a', 'n-b']) },

  // Cross-store leakage
  { name: 'NUR parcel, same ref exists in both stores: only the NUR order', shipment: parcel({ orderRefNumber: '#1234' }), candidates: [organicsTwin, order('n-1234')], expected: matched('n-1234', 'order_ref', 1) },
  { name: 'NUR parcel whose ref exists only in Organics: not found, never the Organics order', shipment: parcel({ orderRefNumber: '#1234' }), candidates: [organicsTwin], expected: unmatched('order_ref_not_found') },
  { name: 'NUR parcel whose COD/city/phone fit only an Organics order: no match', shipment: parcel(), candidates: [organicsTwin], expected: unmatched('no_candidate_matched') },
  { name: 'an Organics order does not make a NUR match ambiguous', shipment: parcel(), candidates: [order('n-1234'), organicsTwin], expected: matched('n-1234', 'cod_city_window', 0.8) },
  { name: 'NUR parcel carrying an Organics prefix is refused, not matched by amount', shipment: parcel({ orderRefNumber: 'JO-1234' }), candidates: [order('n-1234'), organicsTwin], options: { storeId: NUR, refPrefixes: ['NBJ'] }, expected: unmatched('foreign_ref_prefix') },
  { name: 'the same parcel on the Organics account matches only the Organics order', shipment: parcel({ orderRefNumber: '#1234' }), candidates: [order('n-1234'), organicsTwin], options: { storeId: ORGANICS }, expected: matched('o-1234', 'order_ref', 1) },
  { name: 'an account with no linked store matches nothing', shipment: parcel({ orderRefNumber: '#1234' }), candidates: [order('n-1234')], options: { storeId: null }, expected: unmatched('account_has_no_store') },
];

describe('explainMatch', () => {
  for (const c of cases) {
    it(c.name, () => assert.deepEqual(explainMatch(c.shipment, c.candidates, c.options ?? nur), c.expected));
  }
});

describe('matchShipment', () => {
  it('returns the match with its method and confidence, or null', () => {
    for (const c of cases) {
      assert.deepEqual(matchShipment(c.shipment, c.candidates, c.options ?? nur), c.expected.match, c.name);
    }
  });

  it('every match carries a method and a confidence between 0 and 1', () => {
    for (const c of cases) {
      const match = matchShipment(c.shipment, c.candidates, c.options ?? nur);
      if (!match) continue;
      assert.ok(['tracking_note', 'order_ref', 'cod_city_window', 'phone_window'].includes(match.method), c.name);
      assert.ok(match.confidence > 0 && match.confidence <= 1, c.name);
    }
  });

  it('does not depend on the order candidates arrive in', () => {
    for (const c of cases) {
      const reversed = [...c.candidates].reverse();
      assert.deepEqual(explainMatch(c.shipment, reversed, c.options ?? nur), c.expected, c.name);
    }
  });

  it('does not modify its inputs', () => {
    const shipment = parcel();
    const candidates = [order('n-1'), organicsTwin];
    const before = structuredClone({ shipment, candidates });
    matchShipment(shipment, candidates, nur);
    assert.deepEqual({ shipment, candidates }, before);
  });
});

describe('parseOrderRef', () => {
  const table: Array<[string | null, ReturnType<typeof parseOrderRef>]> = [
    ['#1234', { prefix: null, number: '1234' }],
    ['1234', { prefix: null, number: '1234' }],
    ['NBJ-1234', { prefix: 'NBJ', number: '1234' }],
    ['nbj1234', { prefix: 'NBJ', number: '1234' }],
    ['#NBJ #1234', { prefix: 'NBJ', number: '1234' }],
    ['0000', { prefix: null, number: '0' }],
    ['PR-INF-01', null],
    ['#12a4', null],
    ['', null],
    [null, null],
  ];
  for (const [input, expected] of table) {
    it(`parses ${JSON.stringify(input)}`, () => assert.deepEqual(parseOrderRef(input), expected));
  }
});
