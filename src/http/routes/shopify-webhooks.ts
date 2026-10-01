import express, { type Request, type Response, Router } from 'express';

import {
  type WebhookDeps,
  isWebhookTopic,
  processWebhookEvent,
  verifyShopifyHmac,
} from '../../webhooks/shopify.js';

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * `POST /webhooks/shopify/:topic`, where `:topic` is Shopify's topic with `/` as `-`
 * (`orders-create`), so each subscription has its own URL.
 *
 * The raw body parser is mounted here, on this route only, and the app mounts this router
 * before `express.json()`. If that order is ever reversed the body arrives already parsed, every
 * signature fails, and this handler answers 500 saying why instead of silently rejecting all
 * deliveries.
 *
 * The response is sent as soon as the event is stored; processing runs after it. Shopify retries
 * a delivery that is not answered within 5 seconds, and a slow GraphQL call must not cause that.
 *
 * `getDeps` returns null when there is no database, and deliveries are then refused with 503 so
 * Shopify retries them later.
 */
export const shopifyWebhookRouter = (getDeps: () => WebhookDeps | null): Router => {
  const router = Router();

  router.post('/webhooks/shopify/:topic', express.raw({ type: () => true, limit: '2mb' }), async (req: Request, res: Response) => {
    const deps = getDeps();
    if (!deps) {
      res.status(503).json({ error: { message: 'Database not configured' } });
      return;
    }
    const shopDomain = header(req, 'x-shopify-shop-domain') ?? '';
    const topic = header(req, 'x-shopify-topic') ?? '';
    const eventId = header(req, 'x-shopify-event-id') ?? header(req, 'x-shopify-webhook-id');
    // Never the body: it is customer data, and a rejected one may not even be from Shopify.
    const context = { shopDomain, topic, eventId, ip: req.ip };

    if (!Buffer.isBuffer(req.body)) {
      deps.logger.error(context, 'Webhook body was parsed before signature verification; express.json() must come after this router');
      res.status(500).json({ error: { message: 'Webhook body not available raw' } });
      return;
    }

    const store = shopDomain ? await deps.resolveStore(shopDomain) : null;
    if (!store || !verifyShopifyHmac(req.body, header(req, 'x-shopify-hmac-sha256'), store.secret)) {
      deps.logger.warn({ ...context, knownShop: Boolean(store) }, 'Shopify webhook rejected: invalid signature');
      res.status(401).json({ error: { message: 'Invalid signature' } });
      return;
    }

    if (req.params['topic'] !== topic.replaceAll('/', '-')) {
      deps.logger.warn(context, 'Shopify webhook topic does not match its URL');
      res.status(400).json({ error: { message: 'Topic does not match URL' } });
      return;
    }
    if (!isWebhookTopic(topic)) {
      deps.logger.info(context, 'Shopify webhook for a topic we do not handle; acknowledged and ignored');
      res.status(200).json({ ignored: true });
      return;
    }
    if (!eventId) {
      res.status(400).json({ error: { message: 'Missing X-Shopify-Event-Id' } });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      res.status(400).json({ error: { message: 'Body is not JSON' } });
      return;
    }

    // Shopify delivers at least once. The event id is the same on every retry, so a second
    // delivery finds the row already there and is acknowledged without being processed again.
    const [row] = await deps.sql<{ id: string }[]>`
      insert into webhook_events (store_id, topic, shopify_event_id, payload)
      values (${store.id}, ${topic}, ${eventId}, ${deps.sql.json(payload as never)})
      on conflict (store_id, shopify_event_id) do nothing
      returning id
    `;
    if (!row) {
      res.status(200).json({ duplicate: true });
      return;
    }

    res.status(200).json({ received: true });
    const defer = deps.defer ?? ((work) => void setImmediate(() => void work()));
    defer(() =>
      processWebhookEvent(deps, store, row.id).catch((error: unknown) =>
        deps.logger.warn({ ...context, webhookEventId: row.id, err: error }, 'Webhook processing failed; catch-up will retry'),
      ),
    );
  });

  return router;
};
