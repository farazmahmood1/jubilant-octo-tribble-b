import type { PostexSource } from '../jobs/postex.js';
import { mul, paisa, ratio, toRupeeString } from '../lib/money.js';

/**
 * A SYNTHETIC PostEx history at the scale of the spike, and a fake read-only PostEx to serve it.
 * Shapes follow src/integrations/postex/types.ts; nothing here is recorded data. Customer fields
 * are `[masked]`, as a masked recording would have them.
 */

export interface SyntheticSpec {
  total: number;
  delivered: number;
  returned: number;
  /** Sum of transactionFee over delivered parcels, in whole rupees. */
  forwardFeeRupees: number;
  /** Sum of reversalFee over returned parcels, in whole rupees. */
  returnFeeRupees: number;
  from: string;
  to: string;
  trackingPrefix: string;
}

/** The spike's figures (CLAUDE.md): 1,073 parcels, 877 delivered, 117 returned, PKR 209,009 and 27,787. */
export const SPIKE: SyntheticSpec = {
  total: 1_073,
  delivered: 877,
  returned: 117,
  forwardFeeRupees: 209_009,
  returnFeeRupees: 27_787,
  from: '2026-05-14',
  to: '2026-09-19',
  trackingPrefix: '2400',
};

const DAY_MS = 86_400_000;
const addDays = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** 16% of a fee, computed in paisa and handed over as the number PostEx would send. */
const tax16 = (rupees: number): number =>
  Number(toRupeeString(mul(paisa(BigInt(rupees) * 100n), ratio(16n, 100n), 'half-up')));

const step = (code: string, message: string, at: string) => ({ transactionStatusMessage: message, transactionStatusMessageCode: code, updatedAt: at });

/**
 * Fees are spread so the totals are exact: every delivered parcel pays the same base fee, and the
 * first few pay one rupee more until the sum is reached.
 */
export const syntheticParcels = (spec: SyntheticSpec = SPIKE): Array<Record<string, unknown>> => {
  const days = Math.round((Date.parse(spec.to) - Date.parse(spec.from)) / DAY_MS) + 1;
  const forwardBase = Math.floor(spec.forwardFeeRupees / spec.delivered);
  const forwardExtra = spec.forwardFeeRupees - forwardBase * spec.delivered;
  const returnBase = Math.floor(spec.returnFeeRupees / spec.returned);
  const returnExtra = spec.returnFeeRupees - returnBase * spec.returned;

  return Array.from({ length: spec.total }, (_, i) => {
    const booked = addDays(spec.from, Math.floor((i * days) / spec.total));
    const next = addDays(booked, 1);
    const later = addDays(booked, 2);
    const base = {
      trackingNumber: `${spec.trackingPrefix}${String(i).padStart(8, '0')}`,
      orderRefNumber: `#${50_000 + i}`,
      transactionDate: `${booked} 18:00:00`,
      invoicePayment: 2_000 + (i % 10) * 100,
      cityName: ['Lahore', 'Karachi', 'Islamabad', 'Faisalabad'][i % 4],
      items: 1 + (i % 3),
      customerName: '[masked]',
      customerPhone: '[masked]',
      deliveryAddress: '[masked]',
    };
    if (i < spec.delivered) {
      const fee = forwardBase + (i < forwardExtra ? 1 : 0);
      const history = [step('0005', 'Delivered', `${later} 15:00:00`)];
      if (i % 5 === 0) history.unshift(step('0013', 'Attempt Made: CNA(CUSTOMER NOT AVAILABLE)', `${next} 16:00:00`));
      return {
        ...base,
        transactionStatus: 'Delivered',
        orderDeliveryDate: `${later} 15:00:00`,
        statusUpdatedAt: `${later} 15:00:00`,
        transactionFee: fee,
        transactionTax: tax16(fee),
        reversalFee: 0,
        reversalTax: 0,
        transactionStatusHistory: history,
      };
    }
    const r = i - spec.delivered;
    if (r < spec.returned) {
      const fee = returnBase + (r < returnExtra ? 1 : 0);
      const returnedAt = addDays(booked, 8);
      return {
        ...base,
        transactionStatus: 'Returned',
        orderDeliveryDate: null,
        statusUpdatedAt: `${returnedAt} 11:00:00`,
        transactionFee: 0,
        transactionTax: 0,
        reversalFee: fee,
        reversalTax: tax16(fee),
        transactionStatusHistory: [
          step('0013', 'Attempt Made: RFD(REFUSED TO RECEIVE)', `${next} 14:00:00`),
          step('0040', 'Return Initiated', `${later} 10:00:00`),
          step('0006', 'Returned to merchant warehouse', `${returnedAt} 11:00:00`),
        ],
      };
    }
    // Still open: just booked, under review, or carrying a code CLAUDE.md does not list.
    const open = r - spec.returned;
    const history =
      open % 3 === 0 ? [] : open % 3 === 1 ? [step('0008', 'Under review', `${next} 12:00:00`)] : [step('0099', 'Some new status', `${next} 12:00:00`)];
    return { ...base, transactionStatus: open % 3 === 0 ? 'Booked' : 'In Transit', statusUpdatedAt: history.length ? `${next} 12:00:00` : null, transactionStatusHistory: history };
  });
};

export interface FakePostex extends PostexSource {
  parcels: Array<Record<string, unknown>>;
  /** Every call, in order. A write would show up here; the tests assert none does. */
  calls: Array<{ method: string; args: unknown }>;
  failOnce: (method: 'listOrders' | 'trackBulk', nth: number) => void;
}

/**
 * Serves the two read calls the sync makes. The list call returns rows without history, as the
 * cheaper endpoint may; track-bulk returns the full parcel with its history.
 */
export const fakePostex = (parcels: Array<Record<string, unknown>>): FakePostex => {
  const failures = new Map<string, number>();
  const counts = new Map<string, number>();
  const fake: FakePostex = {
    parcels,
    calls: [],
    failOnce: (method, nth) => void failures.set(method, nth),
    listOrders: async ({ from, to }) => {
      fake.calls.push({ method: 'listOrders', args: { from, to } });
      fail('listOrders');
      return fake.parcels
        .filter((p) => {
          const day = String(p['transactionDate']).slice(0, 10);
          return day >= from && day <= to;
        })
        .map(({ transactionStatusHistory: _history, ...row }) => row);
    },
    trackBulk: async (numbers) => {
      fake.calls.push({ method: 'trackBulk', args: numbers.length });
      fail('trackBulk');
      return fake.parcels.filter((p) => numbers.includes(String(p['trackingNumber'])));
    },
  };
  const fail = (method: string) => {
    const n = (counts.get(method) ?? 0) + 1;
    counts.set(method, n);
    if (failures.get(method) === n) {
      failures.delete(method);
      throw new Error(`PostEx ${method}: simulated failure on call ${n}`);
    }
  };
  return fake;
};
