import type { Db } from '../db/repos/upsert.js';
import { type Rate, type ReportFilter, rate } from './filter.js';
import { type Outcome, type OutcomeCounts, outcomeCounts, outcomeQuery, parcelsWithOutcome } from './parcel-outcomes.js';

/**
 * Delivery success: delivered ÷ parcels with a final outcome (delivered, returned or cancelled
 * after booking), and the share of deliveries made on the first attempt. PR parcels excluded.
 */
export interface DeliverySuccess {
  counts: OutcomeCounts;
  success: Rate;
  firstAttempt: Rate;
}

export const deliverySuccess = async (db: Db, f: ReportFilter = {}): Promise<DeliverySuccess> => {
  const counts = await outcomeCounts(db, f);
  return {
    counts,
    success: rate(counts.delivered, counts.delivered + counts.returned + counts.cancelled),
    firstAttempt: rate(counts.deliveredFirstAttempt, counts.delivered),
  };
};

export const explainDeliverySuccess = (db: Db, f: ReportFilter = {}) => outcomeQuery(db, f, true);

export const drillDeliverySuccess = (db: Db, f: ReportFilter, outcome: Outcome) => parcelsWithOutcome(db, f, outcome);
