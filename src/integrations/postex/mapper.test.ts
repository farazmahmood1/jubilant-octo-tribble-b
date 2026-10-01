import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { FIXTURES_DIR, fixture } from '../../test/fixtures.js';
import { PostexMappingError, toCharges, toPayout, toShipment, toShipmentEvents } from './mapper.js';

interface Envelope<T> {
  statusCode: string;
  dist: T;
}

/** The parcel, payment status or list inside a recorded response, as the client hands it over. */
const dist = <T = unknown>(name: string): T => fixture<Envelope<T>>(name).dist;
const at = (iso: string) => new Date(iso);

describe('toShipment', () => {
  it('maps a delivered parcel, reading every date as Karachi time', () => {
    assert.deepEqual(toShipment(dist('postex-track-order-delivered')), {
      trackingNumber: '20000000000001',
      orderRefNumber: '#10001',
      statusCode: '0005',
      statusMessage: 'Delivered',
      statusLabel: 'Delivered',
      bookedAt: at('2026-06-25T13:05:11Z'),
      deliveredAt: at('2026-06-27T11:00:00Z'),
      statusUpdatedAt: at('2026-06-27T11:00:00Z'),
      codAmount: 275_000n,
      city: 'Lahore',
      customerPhone: null,
      items: 2,
      attemptsCount: 1,
      lastFailureReason: 'CNA',
      flags: [],
    });
  });

  it('maps a returned parcel: no delivery date, two refusals, latest code 0006', () => {
    const shipment = toShipment(dist('postex-track-order-returned'));
    assert.equal(shipment.statusCode, '0006');
    assert.equal(shipment.deliveredAt, null);
    assert.deepEqual(shipment.statusUpdatedAt, at('2026-06-01T04:15:00Z'));
    assert.equal(shipment.codAmount, 320_000n);
    assert.equal(shipment.attemptsCount, 2);
    assert.equal(shipment.lastFailureReason, 'RFD');
    assert.deepEqual(shipment.flags, []);
  });

  it('maps a just-booked parcel with no history, no charges and null dates', () => {
    const shipment = toShipment(dist('postex-track-order-booked'));
    assert.equal(shipment.statusCode, null);
    assert.equal(shipment.statusLabel, 'Booked');
    assert.equal(shipment.deliveredAt, null);
    assert.equal(shipment.statusUpdatedAt, null);
    assert.equal(shipment.codAmount, 199_950n);
    assert.equal(shipment.attemptsCount, 0);
    assert.equal(shipment.lastFailureReason, null);
    assert.deepEqual(shipment.flags, ['no_status_history']);
  });

  it('keeps an unknown status code and flags it instead of throwing', () => {
    const shipment = toShipment(dist('postex-track-order-unknown-status'));
    assert.equal(shipment.statusCode, '0099');
    assert.equal(shipment.statusMessage, 'Some New Status');
    assert.deepEqual(shipment.flags, ['unknown_status']);
    assert.equal(shipment.deliveredAt, null, 'an empty-string date is no date');
    assert.equal(shipment.lastFailureReason, 'ICA');
  });

  it('unwraps the trackingResponse wrapper on list rows, including a zero-COD PR parcel', () => {
    const rows = dist<unknown[]>('postex-get-all-order-mixed');
    const shipments = rows.map(toShipment);
    assert.deepEqual(shipments.map((s) => s.trackingNumber), ['20000000000001', '20000000000005', '20000000000003']);
    assert.deepEqual(shipments.map((s) => s.codAmount), [275_000n, 0n, 199_950n]);
    assert.deepEqual(shipments[0], { ...toShipment(dist('postex-track-order-delivered')), statusCode: null, statusMessage: null, attemptsCount: 0, lastFailureReason: null, flags: ['no_status_history'] });
  });

  it('normalises the customer phone, and leaves a masked one null', () => {
    const parcel = { trackingNumber: '1', customerPhone: '0300-1234567' };
    assert.equal(toShipment(parcel).customerPhone, '+923001234567');
    assert.equal(toShipment({ ...parcel, customerPhone: '[masked]' }).customerPhone, null);
  });

  it('flags an unreadable date or amount instead of guessing or throwing', () => {
    const shipment = toShipment({
      trackingNumber: '1',
      orderDeliveryDate: '27/06/2026',
      invoicePayment: 'two thousand',
      reversalFee: 0.1 + 0.2,
    });
    assert.equal(shipment.deliveredAt, null);
    assert.equal(shipment.codAmount, null);
    assert.deepEqual(shipment.flags, ['invalid_amount', 'invalid_date', 'no_status_history']);
  });

  it('accepts a numeric-string amount', () => {
    assert.equal(toShipment({ trackingNumber: '1', invoicePayment: '2,750.00' }).codAmount, 275_000n);
  });

  it('throws only when the parcel cannot be identified at all', () => {
    assert.throws(() => toShipment({ orderRefNumber: '#1' }), PostexMappingError);
    assert.throws(() => toShipment(null), PostexMappingError);
    assert.throws(() => toShipment([]), PostexMappingError);
  });
});

describe('toShipmentEvents', () => {
  it('returns every history step oldest first, with code, message and Karachi time', () => {
    assert.deepEqual(toShipmentEvents(dist('postex-track-order-returned')), [
      { code: '0013', message: 'Attempt Made: RFD(REFUSED TO RECEIVE)', occurredAt: at('2026-05-21T09:30:00Z'), known: true },
      { code: '0013', message: 'Attempt Made: RFD(REFUSED TO RECEIVE)', occurredAt: at('2026-05-22T08:10:00Z'), known: true },
      { code: '0040', message: 'Return Initiated', occurredAt: at('2026-05-23T05:00:00Z'), known: true },
      { code: '0006', message: 'Returned to merchant warehouse', occurredAt: at('2026-06-01T04:15:00Z'), known: true },
    ]);
  });

  it('sorts history PostEx sent newest first', () => {
    const events = toShipmentEvents(dist('postex-track-order-delivered'));
    assert.deepEqual(events.map((e) => e.code), ['0013', '0005']);
  });

  it('keeps an unknown code, marked not known', () => {
    const events = toShipmentEvents(dist('postex-track-order-unknown-status'));
    assert.deepEqual(events.map((e) => [e.code, e.known]), [['0013', true], ['0099', false]]);
  });

  it('reads the short field names in CLAUDE.md the same as the live API names', () => {
    const long = { trackingNumber: '1', transactionStatusHistory: [{ transactionStatusMessageCode: '0005', transactionStatusMessage: 'Delivered', updatedAt: '2026-06-27 16:00:00' }] };
    const short = { trackingNumber: '1', transactionStatusHistory: [{ code: '0005', message: 'Delivered', updatedAt: '2026-06-27 16:00:00' }] };
    assert.deepEqual(toShipmentEvents(short), toShipmentEvents(long));
  });

  it('skips a step with no code, and keeps an undated step after the dated ones', () => {
    const events = toShipmentEvents({
      trackingNumber: '1',
      transactionStatusHistory: [
        { transactionStatusMessage: 'no code' },
        { transactionStatusMessageCode: '0008', transactionStatusMessage: 'Under review' },
        { transactionStatusMessageCode: '0013', transactionStatusMessage: 'Attempt', updatedAt: '2026-06-01 10:00:00' },
      ],
    });
    assert.deepEqual(events.map((e) => e.code), ['0013', '0008']);
  });
});

describe('toCharges', () => {
  it('has no charges for a just-booked parcel', () => {
    assert.deepEqual(toCharges(dist('postex-track-order-booked')), []);
  });

  it('has only forward charges for a delivered parcel', () => {
    assert.deepEqual(toCharges(dist('postex-track-order-delivered')), [
      { kind: 'forward', amount: 18_000n },
      { kind: 'forward_tax', amount: 2_880n },
    ]);
  });

  it('has reversal charges for a returned parcel', () => {
    assert.deepEqual(toCharges(dist('postex-track-order-returned')), [
      { kind: 'reversal', amount: 23_700n },
      { kind: 'reversal_tax', amount: 3_792n },
    ]);
  });

  it('treats a null charge field as no charge', () => {
    assert.deepEqual(toCharges(dist('postex-track-order-unknown-status')), []);
  });

  it('reads the charges on a wrapped list row', () => {
    const [delivered] = dist<unknown[]>('postex-get-all-order-mixed');
    assert.deepEqual(toCharges(delivered), toCharges(dist('postex-track-order-delivered')));
  });
});

describe('toPayout', () => {
  it('maps a settled payout with its CPR number and Karachi date', () => {
    assert.deepEqual(toPayout(dist('postex-payment-status-settled')), {
      trackingNumber: '20000000000001',
      orderRefNumber: '#10001',
      settled: true,
      settledAt: at('2026-07-02T06:00:00Z'),
      cprNumber: 'CPR-0000000123',
      paidAt: at('2026-07-02T06:00:00Z'),
      flags: [],
    });
  });

  it('maps an unsettled payout to nulls', () => {
    assert.deepEqual(toPayout(dist('postex-payment-status-unsettled')), {
      trackingNumber: '20000000000003',
      orderRefNumber: '#10003',
      settled: false,
      settledAt: null,
      cprNumber: null,
      paidAt: null,
      flags: [],
    });
  });

  it('flags an unreadable payout date', () => {
    assert.deepEqual(toPayout({ trackingNumber: '1', settle: true, cpr1Date: '2 July' }).flags, ['invalid_date']);
  });
});

describe('every field in CLAUDE.md', () => {
  // One assertion per field the standing context lists, so a mapping that drops one fails here
  // by name rather than somewhere downstream.
  const delivered = dist('postex-track-order-delivered');
  const returned = dist('postex-track-order-returned');
  const settled = dist('postex-payment-status-settled');

  const cases: Array<[string, () => void]> = [
    ['invoicePayment → codAmount', () => assert.equal(toShipment(delivered).codAmount, 275_000n)],
    ['transactionFee → forward', () => assert.equal(toCharges(delivered).find((c) => c.kind === 'forward')?.amount, 18_000n)],
    ['transactionTax → forward_tax', () => assert.equal(toCharges(delivered).find((c) => c.kind === 'forward_tax')?.amount, 2_880n)],
    ['reversalFee → reversal', () => assert.equal(toCharges(returned).find((c) => c.kind === 'reversal')?.amount, 23_700n)],
    ['reversalTax → reversal_tax', () => assert.equal(toCharges(returned).find((c) => c.kind === 'reversal_tax')?.amount, 3_792n)],
    ['orderDeliveryDate → deliveredAt', () => assert.deepEqual(toShipment(delivered).deliveredAt, at('2026-06-27T11:00:00Z'))],
    ['statusUpdatedAt → statusUpdatedAt', () => assert.deepEqual(toShipment(returned).statusUpdatedAt, at('2026-06-01T04:15:00Z'))],
    ['transactionStatusHistory[].code', () => assert.equal(toShipmentEvents(delivered)[1]?.code, '0005')],
    ['transactionStatusHistory[].message', () => assert.equal(toShipmentEvents(delivered)[0]?.message, 'Attempt Made: CNA(CUSTOMER NOT AVAILABLE)')],
    ['transactionStatusHistory[].updatedAt', () => assert.deepEqual(toShipmentEvents(delivered)[0]?.occurredAt, at('2026-06-26T14:41:03Z'))],
    ['cpr1 → cprNumber', () => assert.equal(toPayout(settled).cprNumber, 'CPR-0000000123')],
    ['cpr1Date → paidAt', () => assert.deepEqual(toPayout(settled).paidAt, at('2026-07-02T06:00:00Z'))],
    ['trackingResponse wrapper', () => assert.equal(toShipment(dist<unknown[]>('postex-get-all-order-mixed')[0]).trackingNumber, '20000000000001')],
  ];
  for (const [field, check] of cases) it(field, check);
});

describe('determinism', () => {
  const names = readdirSync(join(FIXTURES_DIR, 'postex')).map((f) => f.replace(/\.json$/, ''));

  for (const name of names) {
    it(`maps ${name} the same way twice, without touching the input`, () => {
      const body = dist(name);
      const parcels = Array.isArray(body) ? body : [body];
      const before = structuredClone(parcels);
      const map = (p: unknown) =>
        name.startsWith('postex-payment-status')
          ? toPayout(p)
          : { shipment: toShipment(p), events: toShipmentEvents(p), charges: toCharges(p) };
      assert.deepEqual(parcels.map(map), parcels.map(map));
      assert.deepEqual(parcels, before);
    });
  }
});
