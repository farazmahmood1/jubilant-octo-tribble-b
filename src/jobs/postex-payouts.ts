import { getCursor, setCursor } from '../db/repos/cursors.js';
import { awaitingPayout, recordPayout } from '../db/repos/payouts.js';
import { openReviewItem } from '../db/repos/review.js';
import { postPayoutLine } from '../domain/accounting.js';
import { toPayout } from '../integrations/postex/mapper.js';
import { type JobDefinition, type JobStats, SYNC_EVERY_MS } from './runner.js';
import { type PostexDeps, type PostexAccountTarget, configuredPostexAccounts } from './postex.js';

export const PAYOUTS_JOB = 'postex:payouts';
/**
 * Parcels asked about per account per run. One request a second, so 600 is ten minutes; the
 * spike's 877 delivered parcels take two days to work through once, then a day's deliveries are
 * far fewer than this.
 */
export const PAYOUT_BATCH = 600;

/** Parcels a quick check asks about per account: the oldest unpaid, which a new payout pays first. */
export const PROBE_SIZE = 3;
/**
 * Only parcels delivered this recently are probed: one PostEx has left unpaid for longer is an
 * exception (a dispute, a lost parcel), and probing it would hide every new payout behind it.
 */
export const PROBE_WINDOW_MS = 21 * 24 * 60 * 60 * 1000;
/** A full pass at least this often, whatever the quick checks saw: a parcel paid out of order is found within this. */
export const FULL_PASS_MS = 30 * 60 * 1000;

type Counts = { checked: number; paid: number; posted: number; unsettled: number; settledWithoutCpr: number; failed: number };

/** Asks PostEx about one parcel and records it if settled. Says whether it was paid. */
const askAbout = async (
  deps: Omit<PostexDeps, 'tiers' | 'historyFrom'>,
  account: PostexAccountTarget,
  parcel: { id: string; trackingNumber: string },
  counts: Counts,
): Promise<boolean> => {
  counts.checked++;
  let payout;
  try {
    payout = toPayout(await account.source.paymentStatus(parcel.trackingNumber));
  } catch (error) {
    // One parcel PostEx cannot answer for must not stop the rest; it is asked again next run.
    counts.failed++;
    deps.logger.warn({ account: account.key, trackingNumber: parcel.trackingNumber, err: error }, 'PostEx payment status failed');
    return false;
  }
  if (!payout.settled) {
    counts.unsettled++;
    return false;
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
    return false;
  }
  if (await recordPayout(deps.sql, account.id, parcel.id, { ...payout, cprNumber })) {
    counts.paid++;
    const [line] = await deps.sql<{ id: string }[]>`select id from payout_lines where shipment_id = ${parcel.id}`;
    if (line && (await postPayoutLine(deps.sql, line.id))?.created) counts.posted++;
  }
  return true;
};

/**
 * `postex:payouts` (3.2 note S3): for each account, ask PostEx's payment status for delivered and
 * returned parcels not yet on a payout, oldest first, and record the ones it has settled under a
 * CPR, posting each line to the journal (Bank / COD receivable).
 *
 * With `probe`, a quick check: PostEx pays in batches, oldest deliveries first, so only the
 * `probe` oldest unpaid parcels delivered in the last three weeks are asked about, and the rest
 * only if one of them was paid. A new payout is then seen within minutes for a few requests.
 *
 * A parcel PostEx has not settled is simply asked again next run. Idempotent: a parcel on a
 * payout is never selected again, and the payout is keyed on (account, CPR).
 */
export const syncPayouts = async (deps: Omit<PostexDeps, 'tiers' | 'historyFrom'> & { batch?: number; probe?: number; now?: () => Date }): Promise<JobStats> => {
  const stats: JobStats = {};
  const now = (deps.now ?? (() => new Date()))().getTime();
  for (const account of deps.accounts) {
    const counts: Counts = { checked: 0, paid: 0, posted: 0, unsettled: 0, settledWithoutCpr: 0, failed: 0 };
    const due = await awaitingPayout(deps.sql, account.id, deps.batch ?? PAYOUT_BATCH);
    let rest = due;
    if (deps.probe !== undefined) {
      const sample = due.filter((p) => p.deliveredAt !== null && now - p.deliveredAt.getTime() <= PROBE_WINDOW_MS).slice(0, deps.probe);
      let paid = false;
      for (const parcel of sample) {
        if (deps.signal?.aborted) break;
        if (await askAbout(deps, account, parcel, counts)) paid = true;
      }
      rest = paid ? due.filter((p) => !sample.includes(p)) : [];
    }
    for (const parcel of rest) {
      if (deps.signal?.aborted) break;
      await askAbout(deps, account, parcel, counts);
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

/**
 * Every two minutes like the other syncs, as a quick check, with a full pass every half hour:
 * a payout shows within minutes of PostEx making it, for a few requests a run. The time of the
 * last full pass is kept as the job's cursor.
 */
export const payoutsJob: JobDefinition = {
  name: PAYOUTS_JOB,
  schedule: { everyMs: SYNC_EVERY_MS, alignToClock: true },
  handler: async ({ sql, logger, signal }) => {
    const accounts = await configuredPostexAccounts(sql);
    const last = await getCursor(sql, PAYOUTS_JOB, 'full-pass');
    // A little early still counts, so a pass due at the half hour is not put off by a run's jitter.
    const full = !last || Date.now() - Date.parse(last) >= FULL_PASS_MS - SYNC_EVERY_MS / 2;
    const stats = await syncPayouts({ sql, logger, signal, accounts, ...(full ? {} : { probe: PROBE_SIZE }) });
    if (full && !signal?.aborted) await setCursor(sql, PAYOUTS_JOB, 'full-pass', new Date().toISOString());
    return { ...stats, fullPass: full ? 1 : 0 };
  },
};
