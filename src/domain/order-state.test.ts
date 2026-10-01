import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ShipmentEvent } from '../integrations/postex/mapper.js';
import { toShipment, toShipmentEvents } from '../integrations/postex/mapper.js';
import { parsePostexLocal } from '../lib/time.js';
import { fixture } from '../test/fixtures.js';
import {
  type ConfirmationState,
  ORDER_STATES,
  type OrderInput,
  type OrderState,
  type OrderStateInput,
  canonicalOrder,
  deriveOrderState,
  explain,
} from './order-state.js';

const parcelOf = (name: string): unknown => fixture<{ dist: unknown }>(name).dist;
const shipmentOf = (name: string) => toShipment(parcelOf(name));
const eventsOf = (name: string) => toShipmentEvents(parcelOf(name));

const delivered = { shipment: shipmentOf('postex-track-order-delivered'), events: eventsOf('postex-track-order-delivered') };
const returned = { shipment: shipmentOf('postex-track-order-returned'), events: eventsOf('postex-track-order-returned') };
const booked = { shipment: shipmentOf('postex-track-order-booked'), events: eventsOf('postex-track-order-booked') };
const unknown = { shipment: shipmentOf('postex-track-order-unknown-status'), events: eventsOf('postex-track-order-unknown-status') };
const [listDelivered, listPr] = fixture<{ dist: unknown[] }>('postex-get-all-order-mixed').dist.map((row) => toShipment(row));

const online: OrderInput = { channel: 'online', cancelledAt: null };
const cancelledOrder: OrderInput = { channel: 'online', cancelledAt: parsePostexLocal('2026-05-20 13:00:00') };
const confirmed = { state: 'confirmed' as const };

const event = (code: string, at: string | null, message = `status ${code}`): ShipmentEvent => ({
  code,
  message,
  occurredAt: at === null ? null : parsePostexLocal(at),
  known: ['0002', '0005', '0006', '0008', '0013', '0040'].includes(code),
});

const input = (overrides: Partial<OrderStateInput>): OrderStateInput => ({
  order: online,
  shipment: null,
  events: [],
  confirmation: confirmed,
  ...overrides,
});

interface Scenario {
  name: string;
  input: OrderStateInput;
  state: OrderState;
  /** The code of the event expected to decide, when an event decides. */
  decidedByCode?: string;
  anomalies?: string[];
}

const [attempt1, attempt2, returnInitiated, returnedToMerchant] = returned.events as [ShipmentEvent, ShipmentEvent, ShipmentEvent, ShipmentEvent];
const deliveredEvent = delivered.events.find((e) => e.code === '0005')!;

const scenarios: Scenario[] = [
  // From the delivered fixture
  { name: 'delivered parcel → delivered, decided by 0005', input: input({ ...delivered }), state: 'delivered', decidedByCode: '0005' },
  { name: 'delivered fixture after only its CNA attempt → failed', input: input({ shipment: delivered.shipment, events: delivered.events.filter((e) => e.code === '0013') }), state: 'failed', decidedByCode: '0013' },

  // Replaying the returned fixture one event at a time
  { name: 'one refusal → failed', input: input({ shipment: returned.shipment, events: [attempt1] }), state: 'failed', decidedByCode: '0013' },
  { name: 'two refusals → still failed, decided by the second', input: input({ shipment: returned.shipment, events: [attempt1, attempt2] }), state: 'failed', decidedByCode: '0013' },
  { name: 'refusals then 0040 → returning', input: input({ shipment: returned.shipment, events: [attempt1, attempt2, returnInitiated] }), state: 'returning', decidedByCode: '0040' },
  { name: 'full returned history → returned_received, decided by 0006', input: input({ ...returned }), state: 'returned_received', decidedByCode: '0006' },

  // The cases the brief calls out
  { name: 'multiple failed attempts then delivery → delivered', input: input({ shipment: returned.shipment, events: [attempt1, attempt2, event('0005', '2026-05-22 18:00:00', 'Delivered')] }), state: 'delivered', decidedByCode: '0005' },
  { name: 'return initiated then delivered (PostEx does this) → delivered', input: input({ shipment: returned.shipment, events: [attempt1, returnInitiated, event('0005', '2026-05-24 12:00:00', 'Delivered')] }), state: 'delivered', decidedByCode: '0005' },
  { name: 'return initiated and delivered in the same second → delivered', input: input({ shipment: returned.shipment, events: [event('0005', '2026-05-24 12:00:00'), event('0040', '2026-05-24 12:00:00')] }), state: 'delivered', decidedByCode: '0005' },
  { name: 'no shipment yet, confirmed → ready_to_book', input: input({}), state: 'ready_to_book' },
  { name: 'cancelled in Shopify but booked and delivered → delivered, flagged', input: input({ order: cancelledOrder, ...delivered }), state: 'delivered', decidedByCode: '0005', anomalies: ['cancelled_but_booked'] },
  { name: 'cancelled in Shopify, parcel cancelled in PostEx (0002) → cancelled, not flagged', input: input({ order: cancelledOrder, shipment: booked.shipment, events: [event('0002', '2026-09-19 09:00:00', 'Cancelled by merchant')] }), state: 'cancelled', decidedByCode: '0002' },
  { name: 'cancelled at confirmation but booked and returned → returned_received, flagged', input: input({ confirmation: { state: 'cancelled' }, ...returned }), state: 'returned_received', decidedByCode: '0006', anomalies: ['cancelled_but_booked'] },
  { name: 'unknown status after an ICA attempt → stays failed, flagged', input: input({ ...unknown }), state: 'failed', decidedByCode: '0013', anomalies: ['unknown_status'] },
  { name: 'unknown status as the only event → in_transit, flagged', input: input({ shipment: unknown.shipment, events: unknown.events.filter((e) => !e.known) }), state: 'in_transit', decidedByCode: '0099', anomalies: ['unknown_status'] },

  // Parcels with little or no history
  { name: 'booked with no history → booked, decided by the shipment', input: input({ ...booked }), state: 'booked' },
  { name: 'a list row has no history → booked', input: input({ shipment: listDelivered!, events: [] }), state: 'booked' },
  { name: '0008 under review moves a booked parcel to in_transit', input: input({ ...booked, events: [event('0008', '2026-09-19 10:00:00', 'Under review')] }), state: 'in_transit', decidedByCode: '0008' },
  { name: '0008 after a failed attempt changes nothing', input: input({ shipment: returned.shipment, events: [attempt1, event('0008', '2026-05-21 20:00:00')] }), state: 'failed', decidedByCode: '0013' },
  { name: 'delivered then a later 0040 → returning (the later event wins)', input: input({ shipment: delivered.shipment, events: [deliveredEvent, event('0040', '2026-06-30 10:00:00')] }), state: 'returning', decidedByCode: '0040' },
  { name: 'an undated event is replayed last and flagged', input: input({ shipment: returned.shipment, events: [event('0040', null), attempt1] }), state: 'returning', decidedByCode: '0040', anomalies: ['undated_event'] },
  { name: 'delivered after the return was received → delivered (latest wins)', input: input({ shipment: returned.shipment, events: [...returned.events, event('0005', '2026-06-02 10:00:00')] }), state: 'delivered', decidedByCode: '0005' },

  // Before any parcel
  { name: 'no shipment, no confirmation → placed', input: input({ confirmation: null }), state: 'placed' },
  { name: 'no shipment, pending → placed', input: input({ confirmation: { state: 'pending' } }), state: 'placed' },
  { name: 'no shipment, no answer → placed', input: input({ confirmation: { state: 'no_answer' } }), state: 'placed' },
  { name: 'no shipment, unreachable → placed', input: input({ confirmation: { state: 'unreachable' } }), state: 'placed' },
  { name: 'no shipment, changed and confirmed → ready_to_book', input: input({ confirmation: { state: 'changed' } }), state: 'ready_to_book' },
  { name: 'confirmed but on hold in Shopify → confirmed', input: input({ order: { ...online, onHold: true } }), state: 'confirmed' },
  { name: 'cancelled at confirmation, no parcel → cancelled', input: input({ confirmation: { state: 'cancelled' } }), state: 'cancelled' },
  { name: 'cancelled in Shopify, no parcel → cancelled', input: input({ order: cancelledOrder, confirmation: null }), state: 'cancelled' },

  // Channels
  { name: 'PR channel, zero-COD parcel delivered → pr', input: input({ order: { channel: 'pr', cancelledAt: null }, shipment: listPr!, events: [deliveredEvent] }), state: 'pr' },
  { name: 'consignment sale → delivered', input: input({ order: { channel: 'consignment', cancelledAt: null }, confirmation: null }), state: 'delivered' },
];

describe('scenarios', () => {
  assert.ok(scenarios.length >= 20);
  for (const s of scenarios) {
    it(s.name, () => {
      const result = explain(s.input);
      assert.equal(result.state, s.state);
      assert.equal(deriveOrderState(s.input), s.state);
      assert.deepEqual(result.anomalies, s.anomalies ?? []);
      if (s.decidedByCode) {
        assert.equal(result.decidedBy.kind, 'event');
        assert.equal(result.decidedBy.kind === 'event' && result.decidedBy.code, s.decidedByCode);
      } else {
        assert.notEqual(result.decidedBy.kind, 'event');
      }
    });
  }
});

describe('explain names the deciding event', () => {
  it('points at the exact history step, with its time, in the reason and in decidedBy', () => {
    const result = explain(input({ ...returned }));
    assert.deepEqual(result.decidedBy, {
      kind: 'event',
      trackingNumber: '20000000000002',
      code: '0006',
      message: 'Returned to merchant warehouse',
      occurredAt: returnedToMerchant.occurredAt,
    });
    assert.match(result.reason, /PostEx 0006 "Returned to merchant warehouse" at 2026-06-01T04:15:00\.000Z on parcel 20000000000002/);
  });

  it('picks the second of two identical-code attempts, not the first', () => {
    const result = explain(input({ shipment: returned.shipment, events: [attempt2, attempt1] }));
    assert.equal(result.decidedBy.kind === 'event' && result.decidedBy.occurredAt?.toISOString(), attempt2.occurredAt?.toISOString());
  });

  it('says why a cancelled order still follows its parcel', () => {
    assert.match(explain(input({ order: cancelledOrder, ...delivered })).reason, /although the order was cancelled in Shopify/);
  });
});

/** A small deterministic PRNG, so a failing property case can be reproduced exactly. */
const prng = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

const shuffle = <T>(items: readonly T[], random: () => number): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
};

describe('property: arrival order never changes the state', () => {
  const CODES = ['0002', '0005', '0006', '0008', '0013', '0040', '0099', '0001'];

  const randomEvents = (random: () => number): ShipmentEvent[] => {
    const count = Math.floor(random() * 8);
    return Array.from({ length: count }, () => {
      const code = CODES[Math.floor(random() * CODES.length)]!;
      // Few distinct times on purpose: ties are where ordering bugs hide.
      const hour = Math.floor(random() * 4);
      const at = random() < 0.1 ? null : `2026-06-0${1 + Math.floor(random() * 3)} 1${hour}:00:00`;
      return event(code, at);
    });
  };

  it('random histories: shuffled arrival equals timestamp order (2,000 cases)', () => {
    const random = prng(20_261_001);
    for (let i = 0; i < 2_000; i++) {
      const events = randomEvents(random);
      const base = input({ shipment: booked.shipment, events: canonicalOrder(events) });
      const expected = explain(base);
      const arrived = explain({ ...base, events: shuffle(events, random) });
      assert.deepEqual(arrived, expected, `case ${i}: ${JSON.stringify(events)}`);
    }
  });

  it('fixture histories: every permutation of the returned parcel ends returned_received', () => {
    const permutations = (items: ShipmentEvent[]): ShipmentEvent[][] =>
      items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
    for (const order of permutations(returned.events)) {
      assert.equal(deriveOrderState(input({ shipment: returned.shipment, events: order })), 'returned_received');
    }
  });

  it('replaying events one by one as they arrive ends where the full timestamp-ordered history does', () => {
    const random = prng(7);
    for (let i = 0; i < 500; i++) {
      const events = randomEvents(random);
      const arrival = shuffle(events, random);
      let state: OrderState = deriveOrderState(input({ shipment: booked.shipment, events: [] }));
      for (let n = 1; n <= arrival.length; n++) {
        state = deriveOrderState(input({ shipment: booked.shipment, events: arrival.slice(0, n) }));
      }
      assert.equal(state, deriveOrderState(input({ shipment: booked.shipment, events: canonicalOrder(events) })), `case ${i}`);
    }
  });
});

describe('total: every combination returns a state and never throws', () => {
  it('covers every channel × cancellation × confirmation × parcel × history', () => {
    const channels: OrderInput['channel'][] = ['online', 'consignment', 'pr'];
    const confirmations: Array<{ state: ConfirmationState } | null> = [
      null,
      ...(['pending', 'confirmed', 'no_answer', 'changed', 'cancelled', 'unreachable'] as const).map((state) => ({ state })),
    ];
    const histories = [[], delivered.events, returned.events, unknown.events, [event('0099', null)], [{ code: '', message: '', occurredAt: new Date('garbage'), known: false }]];
    let count = 0;
    for (const channel of channels) {
      for (const cancelledAt of [null, cancelledOrder.cancelledAt]) {
        for (const onHold of [false, true]) {
          for (const confirmation of confirmations) {
            for (const shipment of [null, booked.shipment]) {
              for (const events of histories) {
                const state = deriveOrderState({ order: { channel, cancelledAt, onHold }, shipment, events, confirmation });
                assert.ok((ORDER_STATES as readonly string[]).includes(state));
                count++;
              }
            }
          }
        }
      }
    }
    assert.equal(count, 3 * 2 * 2 * 7 * 2 * 6);
  });

  it('survives malformed history: not an array, invalid dates', () => {
    assert.equal(deriveOrderState(input({ ...booked, events: null as never })), 'booked');
    const invalid: ShipmentEvent = { code: '0005', message: 'Delivered', occurredAt: new Date('nope'), known: true };
    const result = explain(input({ ...booked, events: [invalid] }));
    assert.equal(result.state, 'delivered');
    assert.deepEqual(result.anomalies, ['undated_event']);
  });
});
