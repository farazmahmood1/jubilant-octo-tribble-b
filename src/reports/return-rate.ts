import type { Db } from '../db/repos/upsert.js';
import { type ReportFilter, type Rate, rate } from './filter.js';
import { outcomeCounts, outcomeQuery, parcelsWithOutcome } from './parcel-outcomes.js';

/**
 * Return rate: parcels returned to the merchant ÷ parcels with a final delivered-or-returned
 * outcome, booked in the period. PR parcels are excluded. Parcels still in flight are not in
 * the denominator: they have no outcome yet, and counting them would make a busy week look good.
 */
export const returnRate = async (db: Db, f: ReportFilter = {}): Promise<Rate> => {
  const c = await outcomeCounts(db, f);
  return rate(c.returned, c.delivered + c.returned);
};

export const explainReturnRate = (db: Db, f: ReportFilter = {}) => outcomeQuery(db, f, true);

/** The returned parcels. */
export const drillReturnRate = (db: Db, f: ReportFilter = {}) => parcelsWithOutcome(db, f, 'returned');
