import { awaitingPayout, recordPayout } from '../db/repos/payouts.js';
import { openReviewItem } from '../db/repos/review.js';
import { toPayout } from '../integrations/postex/mapper.js';
import { OVERNIGHT, type JobDefinition, type JobStats } from './runner.js';
import { type PostexDeps, configuredPostexAccounts } from './postex.js';

export const PAYOUTS_JOB = 'postex:payouts';
/**
 * Parcels asked about per account per run. One request a second, so 600 is ten minutes; the
 * spike's 877 delivered parcels take two days to work through once, then a day's deliveries are
 * far fewer than this.
 */
export const PAYOUT_BATCH = 600;

/**
 * `postex:payouts` (3.2 note S3): for each account, ask PostEx's payment status for delivered
 * parcels not yet on a payout, oldest first, and record the ones it has settled under a CPR.
 * A parcel PostEx has not settled is simply asked again next run. Idempotent: a parcel on a
 * payout is never selected again, and the payout is keyed on (account, CPR).
 */
export const syncPayouts = async (deps: Omit<PostexDeps, 'tiers' | 'historyFrom'> & { batch?: number }): Promise<JobStats> => {
  const stats: JobStats = {};
  for (const account of deps.accounts) {
    const counts = { checked: 0, paid: 0, unsettled: 0, settledWithoutCpr: 0, failed: 0 };
    const due = await awaitingPayout(deps.sql, account.id, deps.batch ?? PAYOUT_BATCH);
    for (const parcel of due) {
      if (deps.signal?.aborted) break;
      counts.checked++;
      let payout;
      try {
        payout = toPayout(await account.source.paymentStatus(parcel.trackingNumber));
      } catch (error) {
        // One parcel PostEx cannot answer for must not stop the rest; it is asked again next run.
        counts.failed++;
        deps.logger.warn({ account: account.key, trackingNumber: parcel.trackingNumber, err: error }, 'PostEx payment status failed');
        continue;
      }
      if (!payout.settled) {
        counts.unsettled++;
        continue;
      }
      const { cprNumber } = payout;
      if (!cprNumber) {
        counts.settledWithoutCpr++;
        await openReviewItem(deps.sql, {
          kind: 'payout_without_cpr',
          dedupeKey: `payout_without_cpr:${parcel.id}`,
          shipmentId: parcel.id,
          detail: { account: account.key, trackingNumber: parcel.trackingNumber },
        });
        continue;
      }
      if (await recordPayout(deps.sql, account.id, parcel.id, { ...payout, cprNumber })) counts.paid++;
    }
    // Every request failing is PostEx or the network, not a parcel: the run should say so.
    if (counts.checked > 0 && counts.failed === counts.checked) {
      throw new Error(`PostEx payment status failed for all ${counts.checked} parcels of account ${account.key}`);
    }
    for (const [key, value] of Object.entries(counts)) {
      stats[key] = (Number(stats[key]) || 0) + value;
      stats[`${account.key}.${key}`] = value;
    }
  }
  return stats;
};

export const payoutsJob: JobDefinition = {
  name: PAYOUTS_JOB,
  // Daily. PostEx pays out a few times a week; a day's delay in seeing it costs nothing.
  schedule: { everyMs: 24 * 60 * 60 * 1000, alignToClock: true, quiet: OVERNIGHT },
  handler: async ({ sql, logger, signal }) => syncPayouts({ sql, logger, signal, accounts: await configuredPostexAccounts(sql) }),
};
