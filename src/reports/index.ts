import type { Db } from '../db/repos/upsert.js';
import { type Dimension, DIMENSIONS, explainBreakdown, explainProductBreakdown } from './breakdowns.js';
import { explainCashAwaitingPayout } from './cash-awaiting-payout.js';
import { explainDeliveredRevenue } from './delivered-revenue.js';
import { explainDeliverySuccess } from './delivery-success.js';
import type { ReportFilter } from './filter.js';
import { explainGeneralLedger } from './general-ledger.js';
import { explainOrderFunnel } from './order-funnel.js';
import { explainPartnerLedger } from './partner-ledger.js';
import { explainPnl } from './pnl.js';
import { explainProfitPerParcel } from './profit-per-parcel.js';
import { explainReturnRate } from './return-rate.js';
import { explainReturnRateBy } from './return-rate-by.js';
import { explainTrialBalance } from './trial-balance.js';

/**
 * Every dashboard number (Step 14), each computed once, in SQL, from the ledger: one file per
 * report, each with a typed filter, typed rows and a drill-down to the ids behind the figure.
 * Nothing here writes. The API and the dashboard read these; they do not re-derive figures.
 */
export * from './breakdowns.js';
export * from './cash-awaiting-payout.js';
export * from './delivered-revenue.js';
export * from './delivery-success.js';
export type { Rate, ReportFilter } from './filter.js';
export * from './general-ledger.js';
export * from './lines.js';
export * from './order-funnel.js';
export * from './partner-ledger.js';
export * from './pnl.js';
export * from './profit-per-parcel.js';
export * from './recent-orders.js';
export * from './return-rate.js';
export * from './return-rate-by.js';
export * from './trial-balance.js';

export interface ReportPlan {
  plan: (db: Db, f: ReportFilter) => Promise<unknown>;
  /**
   * The indexes this report's plan must use for a dated, per-store filter. The trial balance
   * and partner ledger read every line by design and need none beyond the ledger's own.
   */
  needs: string[];
}

/** Each report's query plan and the indexes it relies on: what the EXPLAIN checks run over. */
export const REPORT_PLANS: Record<string, ReportPlan> = {
  deliveredRevenue: { plan: explainDeliveredRevenue, needs: ['journal_lines_account_idx'] },
  pnl: { plan: explainPnl, needs: ['journal_entries_date_idx'] },
  trialBalance: { plan: explainTrialBalance, needs: [] },
  generalLedger: { plan: (db, f) => explainGeneralLedger(db, '1100', f), needs: ['journal_lines_account_idx'] },
  partnerLedger: { plan: explainPartnerLedger, needs: [] },
  returnRate: { plan: explainReturnRate, needs: ['shipments_booked_idx'] },
  returnRateBy: { plan: explainReturnRateBy, needs: ['shipments_booked_idx'] },
  deliverySuccess: { plan: explainDeliverySuccess, needs: ['shipments_booked_idx'] },
  orderFunnel: { plan: explainOrderFunnel, needs: ['orders_placed_idx'] },
  cashAwaitingPayout: { plan: explainCashAwaitingPayout, needs: ['journal_lines_account_idx', 'journal_entries_live_source_key'] },
  profitPerParcel: { plan: explainProfitPerParcel, needs: ['journal_entries_date_idx'] },
  productBreakdown: { plan: explainProductBreakdown, needs: ['journal_entries_date_idx', 'product_costs_lookup_idx'] },
  ...Object.fromEntries(
    DIMENSIONS.map((d: Dimension) => [
      `breakdown.${d}`,
      { plan: (db: Db, f: ReportFilter) => explainBreakdown(db, d, f), needs: d === 'partner' ? ['journal_entries_date_idx', 'journal_entries_source_idx'] : ['journal_entries_date_idx'] },
    ]),
  ),
};
