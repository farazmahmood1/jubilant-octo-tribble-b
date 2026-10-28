/**
 * Registers the Shopify webhooks for every configured store, pointing at one backend.
 * Run with: npm run webhooks -- https://backend.example.com          (shows the plan, changes nothing)
 *           npm run webhooks -- https://backend.example.com --apply  (creates, moves and removes)
 *
 * Each topic gets `<base>/webhooks/shopify/<topic with - for />`. A subscription already at the
 * right URL is left alone; one for the same topic at another URL (the backend moved) is updated to
 * the new one, and a duplicate is deleted. Subscriptions for topics we do not handle are listed,
 * never touched.
 *
 * The GDPR topics (customers/data_request, customers/redact, shop/redact) cannot be subscribed
 * through the API: they are set in the app's configuration in the Shopify Dev Dashboard, as the
 * "compliance webhooks", with the same URLs this prints.
 */
import { config } from '../config.js';
import { shopifyClients } from '../integrations/shopify/client.js';
import { WEBHOOK_TOPICS } from '../webhooks/shopify.js';

const GDPR_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'];
const TOPICS = WEBHOOK_TOPICS.filter((t) => !GDPR_TOPICS.includes(t));

/** `orders/create` -> `ORDERS_CREATE`, Shopify's GraphQL enum. */
const topicEnum = (topic: string) => topic.replaceAll('/', '_').toUpperCase();

interface Subscription {
  id: string;
  topic: string;
  uri: string;
}

const LIST = `query ($after: String) {
  webhookSubscriptions(first: 100, after: $after) {
    nodes { id topic uri }
    pageInfo { hasNextPage endCursor }
  }
}`;

const CREATE = `mutation ($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { userErrors { field message } }
}`;

const UPDATE = `mutation ($id: ID!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) { userErrors { field message } }
}`;

const DELETE = `mutation ($id: ID!) {
  webhookSubscriptionDelete(id: $id) { userErrors { field message } }
}`;

type Result = Record<string, { userErrors: Array<{ field: string[] | null; message: string }> }>;

const line = (label: string, detail: string) => console.log(`  ${label.padEnd(22)} ${detail}`);

const run = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const raw = args.find((a) => !a.startsWith('--'));
  if (!raw) throw new Error('Usage: npm run webhooks -- <backend base URL> [--apply]');
  const base = new URL(raw);
  if (base.protocol !== 'https:') throw new Error('Shopify only delivers to https URLs');
  const urlFor = (topic: string) => new URL(`/webhooks/shopify/${topic.replaceAll('/', '-')}`, base).toString();

  const clients = shopifyClients();
  if (clients.length === 0) throw new Error('No Shopify store has complete credentials');
  console.log(`\nShopify webhooks -> ${base.origin} (API ${config.shopify.apiVersion})${apply ? '' : ' — dry run, add --apply to change'}`);

  for (const client of clients) {
    console.log(`\n${client.key} (${client.domain})`);
    const existing: Subscription[] = [];
    let after: string | null = null;
    do {
      const data: { webhookSubscriptions: { nodes: Subscription[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
        await client.graphql(LIST, { after });
      existing.push(...data.webhookSubscriptions.nodes);
      after = data.webhookSubscriptions.pageInfo.hasNextPage ? data.webhookSubscriptions.pageInfo.endCursor : null;
    } while (after);

    const run = async (action: string, topic: string, query: string, variables: Record<string, unknown>) => {
      if (!apply) {
        line(topic, `would ${action}`);
        return;
      }
      const result = await client.graphql<Result>(query, variables);
      const errors = Object.values(result).flatMap((r) => r.userErrors);
      line(topic, errors.length ? `FAILED to ${action}: ${errors.map((e) => e.message).join('; ')}` : `${action}d`);
      if (errors.length) process.exitCode = 1;
    };

    for (const topic of TOPICS) {
      const url = urlFor(topic);
      const sub = { uri: url, format: 'JSON' };
      const mine = existing.filter((s) => s.topic === topicEnum(topic));
      const keep = mine.find((s) => s.uri === url) ?? mine[0];
      if (!keep) await run('create', topic, CREATE, { topic: topicEnum(topic), sub });
      else if (keep.uri === url) line(topic, 'ok');
      else await run('update', topic, UPDATE, { id: keep.id, sub });
      for (const extra of mine.filter((s) => s !== keep)) await run('delete', `${topic} (duplicate)`, DELETE, { id: extra.id });
    }

    const handled = new Set(TOPICS.map(topicEnum));
    for (const other of existing.filter((s) => !handled.has(s.topic))) line(other.topic, `not ours, left alone: ${other.uri}`);
  }

  console.log(`\nSet these as the compliance webhooks in the app's settings (Shopify Dev Dashboard):`);
  for (const topic of GDPR_TOPICS) line(topic, urlFor(topic));
  console.log();
};

run()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
