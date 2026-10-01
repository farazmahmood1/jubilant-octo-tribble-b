import { processPendingWebhooks } from '../webhooks/shopify.js';
import { type JobDefinition, type JobStats, OVERNIGHT } from './runner.js';
import { type Counts, type SyncDeps, configuredStores, flatten, retrySkippedOrders, syncOrders } from './shopify.js';

export const CATCHUP_JOB = 'shopify:catchup';

/** Re-read orders updated this recently, whatever the cursor says. Wide enough to cover a webhook outage. */
export const CATCHUP_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Leave a just-received webhook to its own processing; retry only ones this old and still unprocessed. */
export const PENDING_WEBHOOK_AGE_MS = 2 * 60 * 1000;

/**
 * The safety net behind webhooks, every 15 minutes:
 * 1. process webhook events that were received but never processed (the process died, or
 *    Shopify's API was down when it tried);
 * 2. retry orders the sync could not store, from the review queue;
 * 3. re-read every order updated in the last two hours, which recovers a webhook Shopify never
 *    delivered at all. It leaves the `shopify:orders` cursor alone.
 */
export const catchUp = async (deps: SyncDeps): Promise<JobStats> => {
  const now = deps.now ?? (() => new Date());
  const webhooks = await processPendingWebhooks(deps, deps.stores, PENDING_WEBHOOK_AGE_MS, deps.signal);

  const retries = new Map<string, Counts>();
  await retrySkippedOrders(deps, retries);

  const recent = await syncOrders(deps, { since: new Date(now().getTime() - CATCHUP_WINDOW_MS), saveCursor: false });
  const retryStats = flatten(retries);
  const prefixed = Object.fromEntries(Object.entries(retryStats).map(([key, value]) => [`retry.${key}`, value]));
  return { ...recent, ...prefixed, webhooksRetried: webhooks.retried, webhooksFailed: webhooks.failed };
};

export const catchupJob: JobDefinition = {
  name: CATCHUP_JOB,
  // On the quarter hour with postex:sync, so the two wake the database together; hourly overnight.
  schedule: { everyMs: 15 * 60 * 1000, alignToClock: true, quiet: OVERNIGHT },
  handler: async ({ sql, logger, signal }) => catchUp({ sql, logger, signal, stores: await configuredStores(sql) }),
};
