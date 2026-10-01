import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toShipment, toShipmentEvents } from '../integrations/postex/mapper.js';
import { type Paisa, paisa } from '../lib/money.js';
import { fixture } from '../test/fixtures.js';
import {
  type OrderFacts,
  type ParcelFacts,
  type RuleInput,
  codMismatch,
  duplicateBooking,
  evaluate,
  stuckInTransit,
  unknownStatus,
  unmatchedParcel,
} from './reconciliation.js';

/**
 * Each rule against the recorded PostEx fixtures (delivered, returned, booked, unknown status),
 * mapped exactly as the sync maps them, with one case that must flag and a near miss that must not.
 */

type Case = 'delivered' | 'returned' | 'booked' | 'unknown-status';

const parcelFrom = (name: Case, overrides: Partial<ParcelFacts> = {}): { parcel: ParcelFacts; events: RuleInput['events'] } => {
  const raw = fixture<{ dist: unknown }>(`postex-track-order-${name}`).dist;
  const shipment = toShipment(raw);
  return {
    parcel: {
      id: String(shipment.trackingNumber.slice(-2)),
      accountKey: 'nur',
      trackingNumber: shipment.trackingNumber,
      orderRefNumber: shipment.orderRefNumber,
      orderId: '501',
      codAmount: shipment.codAmount,
      statusCode: shipment.statusCode,
      bookedAt: shipment.bookedAt,
      statusUpdatedAt: shipment.statusUpdatedAt,
      ...overrides,
    },
    events: toShipmentEvents(raw).map((e) => ({ code: e.code })),
  };
};

const order = (total: Paisa, overrides: Partial<OrderFacts> = {}): OrderFacts => ({
  id: '501',
  orderNumber: '#10001',
  totalPaisa: total,
  financialStatus: 'pending',
  channel: 'online',
  ...overrides,
});

const input = (name: Case, extra: Partial<Omit<RuleInput, 'parcel'>> & { parcel?: Partial<ParcelFacts> } = {}): RuleInput => {
  const { parcel, events } = parcelFrom(name, extra.parcel);
  const { parcel: _overrides, ...rest } = extra;
  return {
    order: order(parcel.codAmount ?? paisa(0n)),
    siblings: [],
    now: new Date('2026-09-20T06:00:00Z'),
    stuckDays: 7,
    ...rest,
    parcel,
    events: extra.events ?? events,
  };
};

describe('unmatched_shipment', () => {
  it('flags a parcel with no order', () => {
    const finding = unmatchedParcel(input('delivered', { parcel: { orderId: null }, order: null }));
    assert.equal(finding?.kind, 'unmatched_shipment');
    assert.equal(finding?.detail['trackingNumber'], '20000000000001');
  });

  it('near miss: a parcel linked by hand is matched like any other', () => {
    assert.equal(unmatchedParcel(input('delivered')), null);
  });
});

describe('cod_mismatch', () => {
  it('flags COD that differs from the order total by one paisa', () => {
    const base = input('delivered');
    const finding = codMismatch({ ...base, order: order(paisa(base.parcel.codAmount! + 1n)) });
    assert.deepEqual(
      [finding?.kind, finding?.detail['codPaisa'], finding?.detail['expectedPaisa'], finding?.detail['differencePaisa']],
      ['cod_mismatch', '275000', '275001', '-1'],
    );
  });

  it('flags zero COD on an unpaid order, marked as zero COD for the PR/gift review', () => {
    const finding = codMismatch(input('delivered', { parcel: { codAmount: paisa(0n) }, order: order(paisa(275_000n)) }));
    assert.equal(finding?.detail['zeroCod'], true);
  });

  it('near misses: exact COD in paisa (Rs 1,999.50); a prepaid order with zero COD; a PR order; COD not reported', () => {
    assert.equal(codMismatch(input('booked')), null);
    assert.equal(codMismatch(input('delivered', { parcel: { codAmount: paisa(0n) }, order: order(paisa(275_000n), { financialStatus: 'paid' }) })), null);
    assert.equal(codMismatch(input('delivered', { parcel: { codAmount: paisa(0n) }, order: order(paisa(275_000n), { channel: 'pr' }) })), null);
    assert.equal(codMismatch(input('delivered', { parcel: { codAmount: null } })), null);
  });
});

describe('possible_duplicate_booking', () => {
  it('flags two live parcels for one order, as one item for the group', () => {
    const a = input('booked', { siblings: [{ id: '03', trackingNumber: '20000000000003', statusCode: null }, { id: '09', trackingNumber: '20000000000009', statusCode: '0008' }] });
    const finding = duplicateBooking(a);
    assert.equal(finding?.dedupeKey, 'possible_duplicate_booking:order:501');
    assert.deepEqual(finding?.detail['shipmentIds'], ['03', '09']);
  });

  it('keeps each parcel id with its own tracking number, even when the two sort in opposite orders', () => {
    // The parcel under test is id 03. Ids sort 03 < 05 < 11 while tracking numbers sort 01 < 03 < 99
    // (ids 11, 03, 05): pairing by position would swap them.
    const finding = duplicateBooking(
      input('booked', { siblings: [{ id: '05', trackingNumber: '20000000000099', statusCode: null }, { id: '11', trackingNumber: '20000000000001', statusCode: '0008' }] }),
    );
    const parcels = finding?.detail['parcels'] as Array<{ id: string; trackingNumber: string }>;
    assert.deepEqual(parcels.find((p) => p.id === '05'), { id: '05', trackingNumber: '20000000000099' });
    assert.deepEqual(parcels.find((p) => p.id === '11'), { id: '11', trackingNumber: '20000000000001' });
    assert.equal(parcels.length, 3, 'the parcel itself and both siblings');
  });

  it('flags a second parcel booked after the first was delivered (a person decides whether it is a replacement)', () => {
    assert.ok(duplicateBooking(input('booked', { siblings: [{ id: '01', trackingNumber: '20000000000001', statusCode: '0005' }] })));
  });

  it('groups unmatched parcels by their reference', () => {
    const finding = duplicateBooking(input('booked', { parcel: { orderId: null }, order: null, siblings: [{ id: '07', trackingNumber: 'X7', statusCode: null }] }));
    assert.equal(finding?.dedupeKey, 'possible_duplicate_booking:ref:nur:#10003');
  });

  it('near misses: a re-send after the first parcel came back or was cancelled; a parcel alone', () => {
    assert.equal(duplicateBooking(input('booked', { siblings: [{ id: '02', trackingNumber: '20000000000002', statusCode: '0006' }] })), null);
    assert.equal(duplicateBooking(input('booked', { siblings: [{ id: '05', trackingNumber: 'X5', statusCode: '0002' }] })), null);
    assert.equal(duplicateBooking(input('booked', { siblings: [{ id: '03', trackingNumber: '20000000000003', statusCode: null }] })), null, 'only itself');
    // The returned parcel itself is out of the race, whatever its siblings are doing.
    assert.equal(duplicateBooking(input('returned', { siblings: [{ id: '03', trackingNumber: 'X3', statusCode: null }] })), null);
  });
});

describe('stuck_in_transit', () => {
  it('flags an open parcel with no status change for 7 Karachi days', () => {
    // Unknown-status fixture: last update 12 Sep 08:30 Karachi; 19 Sep is day 7.
    const finding = stuckInTransit(input('unknown-status', { now: new Date('2026-09-19T00:00:00Z') }));
    assert.deepEqual([finding?.kind, finding?.detail['days']], ['stuck_in_transit', 7]);
  });

  it('falls back to the booking time for a parcel with no history', () => {
    // Booked 18 Sep 21:40 Karachi, nothing since.
    assert.ok(stuckInTransit(input('booked', { now: new Date('2026-09-25T00:00:00Z') })));
  });

  it('near misses: six days is not stuck; old delivered and returned parcels never are', () => {
    assert.equal(stuckInTransit(input('unknown-status', { now: new Date('2026-09-18T18:59:00Z') })), null, '18 Sep 23:59 Karachi is day 6');
    assert.equal(stuckInTransit(input('delivered')), null);
    assert.equal(stuckInTransit(input('returned')), null);
  });
});

describe('postex_unknown_status', () => {
  it('flags each code CLAUDE.md does not list, keyed by code so all parcels share one item', () => {
    const findings = unknownStatus(input('unknown-status'));
    assert.deepEqual(findings.map((f) => f.dedupeKey), ['postex_unknown_status:0099']);
  });

  it('near miss: a history of listed codes only, including 0013 twice', () => {
    assert.deepEqual(unknownStatus(input('returned')), []);
  });
});

describe('evaluate', () => {
  it('a clean delivered parcel raises nothing; an unmatched stale parcel with an odd code raises three', () => {
    assert.deepEqual(evaluate(input('delivered')), []);
    const kinds = evaluate(input('unknown-status', { parcel: { orderId: null }, order: null })).map((f) => f.kind);
    assert.deepEqual(kinds, ['unmatched_shipment', 'stuck_in_transit', 'postex_unknown_status']);
  });
});
