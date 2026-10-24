import { type ShopifyReturnsGateway, returnsWritebackEnabled, syncCheckInToShopify, writebacksToRecheck } from '../domain/shopify-returns.js';
import { processPendingWebhooks } from '../webhooks/shopify.js';
import { type JobDefinition, type JobStats, SYNC_EVERY_MS } from './runner.js';
import { type Counts, type SyncDeps, configuredStores, flatten, retrySkippedOrders, syncOrders } from './shopify.js';

export const CATCHUP_JOB = 'shopify:catchup';

/** Re-read orders updated this recently, whatever the cursor says. Wide enough to cover a webhook outage. */
export const CATCHUP_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Leave a just-received webhook to its own processing; retry only ones this old and still unprocessed. */
export const PENDING_WEBHOOK_AGE_MS = 2 * 60 * 1000;

/** A return waiting on its Shopify order, or refused by Shopify, is looked at again this long after its last attempt. */
export const WRITEBACK_RECHECK_MS = 10 * 60 * 1000;

/**
 * The safety net behind webhooks, every 2 minutes:
 * 1. process webhook events that were received but never processed (the process died, or
 *    Shopify's API was down when it tried);
 * 2. retry orders the sync could not store, from the review queue;
 * 3. re-read every order updated in the last two hours, which recovers a webhook Shopify never
 *    delivered at all. It leaves the `shopify:orders` cursor alone;
 * 4. re-check returns whose Shopify stock is waiting on the order (still open there) or failed,
 *    so cancelling the order in Shopify, or Shopify coming back, settles them with nobody pressing
 *    Retry. An unchanged answer records nothing.
 */
export const catchUp = async (deps: SyncDeps & { returns?: ShopifyReturnsGateway }): Promise<JobStats> => {
  const now = deps.now ?? (() => new Date());
  const webhooks = await processPendingWebhooks(deps, deps.stores, PENDING_WEBHOOK_AGE_MS, deps.signal);

  const retries = new Map<string, Counts>();
  await retrySkippedOrders(deps, retries);

  const recent = await syncOrders(deps, { since: new Date(now().getTime() - CATCHUP_WINDOW_MS), saveCursor: false });
  const retryStats = flatten(retries);
  const prefixed = Object.fromEntries(Object.entries(retryStats).map(([key, value]) => [`retry.${key}`, value]));

  const writebacks: Record<string, number> = { writebacksRechecked: 0, writebacksSettled: 0 };
  if (await returnsWritebackEnabled(deps.sql)) {
    for (const checkInId of await writebacksToRecheck(deps.sql, WRITEBACK_RECHECK_MS)) {
      if (deps.signal?.aborted) break;
      const state = await syncCheckInToShopify(deps.sql, { checkInId, actorId: null, quiet: true, ...(deps.returns ? { gateway: deps.returns } : {}) });
      writebacks['writebacksRechecked']!++;
      if (state.outcome === 'done' || state.outcome === 'skipped') writebacks['writebacksSettled']!++;
    }
  }
  return { ...recent, ...prefixed, webhooksRetried: webhooks.retried, webhooksFailed: webhooks.failed, ...writebacks };
};

export const catchupJob: JobDefinition = {
  name: CATCHUP_JOB,
  // Same cadence as postex:sync, around the clock.
  schedule: { everyMs: SYNC_EVERY_MS, alignToClock: true },
  handler: async ({ sql, logger, signal }) => catchUp({ sql, logger, signal, stores: await configuredStores(sql) }),
};
