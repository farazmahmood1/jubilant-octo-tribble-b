import type { PostexAccountConfig } from '../../config.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

import type { PostexParcel, PostexPaymentStatus, PostexStatusId } from './types.js';

const BASE_URL = 'https://api.postex.pk/services/integration/api/order';
const REQUEST_TIMEOUT_MS = 45_000;
/** PostEx publishes no rate limits, so stay at one request per second per account. */
const MIN_INTERVAL_MS = 1_000;
const RETRY_DELAYS_MS = [1_000, 4_000, 15_000];

export class PostexError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly statusCode?: string,
  ) {
    super(message);
    this.name = 'PostexError';
  }
}

interface Envelope<T> {
  statusCode?: string | number;
  statusMessage?: string;
  message?: string;
  dist?: T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read-only PostEx client.
 *
 * It deliberately exposes no way to book, cancel or advise on a parcel, and no call to the
 * shipper advice endpoints at all, not even the read (CLAUDE.md rule 1). PostEx has no sandbox,
 * so any write would touch real shipments and real money. When booking is added later it must
 * go behind `config.postex.allowWrites` and the idempotency rules (unique reference written
 * before the call, never retry a timed-out create).
 */
export class PostexClient {
  private lastRequestAt = 0;

  constructor(private readonly account: PostexAccountConfig) {}

  get key(): string {
    return this.account.key;
  }

  /** The status vocabulary this account uses. Labels differ between endpoints, so store raw values. */
  async getOrderStatuses(): Promise<string[]> {
    return this.get<string[]>('/v1/get-order-status');
  }

  /** Orders booked between two dates (yyyy-mm-dd, merchant local time). */
  async listOrders(params: { from: string; to: string; statusId?: PostexStatusId }): Promise<PostexParcel[]> {
    const dist = await this.get<unknown>('/v1/get-all-order', {
      orderStatusId: params.statusId ?? 0,
      startDate: params.from,
      endDate: params.to,
    });
    return unwrapParcels(dist);
  }

  async trackOrder(trackingNumber: string): Promise<PostexParcel> {
    const dist = await this.get<unknown>(`/v1/track-order/${encodeURIComponent(trackingNumber)}`);
    const [parcel] = unwrapParcels(dist);
    if (!parcel) throw new PostexError(`No parcel returned for ${trackingNumber}`, 404);
    return parcel;
  }

  /** Many parcels in one call, including their full status history. */
  async trackBulk(trackingNumbers: string[]): Promise<PostexParcel[]> {
    if (trackingNumbers.length === 0) return [];
    const dist = await this.get<unknown>('/v1/track-bulk-order', { TrackingNumbers: trackingNumbers.join(',') });
    return unwrapParcels(dist);
  }

  async paymentStatus(trackingNumber: string): Promise<PostexPaymentStatus> {
    return this.get<PostexPaymentStatus>(`/v1/payment-status/${encodeURIComponent(trackingNumber)}`);
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      await this.throttle();
      try {
        const response = await fetch(url, {
          headers: { token: this.account.token, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const text = await response.text();
        let body: Envelope<T>;
        try {
          body = JSON.parse(text) as Envelope<T>;
        } catch {
          throw new PostexError(`PostEx returned non-JSON from ${path}: ${text.slice(0, 200)}`, response.status);
        }

        // PostEx reports failures in the body while using assorted HTTP codes, so check both.
        const statusCode = String(body.statusCode ?? response.status);
        if (!response.ok || !['200', 'SUCCESS'].includes(statusCode)) {
          const message = body.statusMessage ?? body.message ?? text.slice(0, 200);
          const error = new PostexError(`PostEx ${path}: ${message}`, response.status, statusCode);
          // 4xx means a bad request or a bad token; retrying only hides the problem.
          if (response.status < 500 && response.status !== 429) throw error;
          lastError = error;
        } else {
          return body.dist as T;
        }
      } catch (error) {
        if (error instanceof PostexError && error.httpStatus < 500 && error.httpStatus !== 429) throw error;
        lastError = error;
      }

      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      logger.warn({ account: this.account.key, path, attempt: attempt + 1 }, 'PostEx request failed, retrying');
      await sleep(delay);
    }
    throw lastError instanceof Error ? lastError : new PostexError(`PostEx ${path} failed`, 0);
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }
}

/**
 * get-all-order and track-bulk-order wrap each parcel as { trackingResponse, trackingNumber },
 * while track-order returns the parcel directly.
 */
const unwrapParcels = (dist: unknown): PostexParcel[] => {
  if (!dist) return [];
  const list = Array.isArray(dist)
    ? dist
    : typeof dist === 'object'
      ? (Object.values(dist as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined) ?? [dist]
      : [];
  return list
    .map((row) => {
      const record = row as Record<string, unknown>;
      return (record?.['trackingResponse'] ?? record) as PostexParcel;
    })
    .filter((parcel): parcel is PostexParcel => Boolean(parcel?.trackingNumber));
};

const clients = new Map<string, PostexClient>();

/** One client per PostEx merchant account, so each keeps its own throttle. */
export const postexClient = (accountKey: string): PostexClient => {
  const existing = clients.get(accountKey);
  if (existing) return existing;
  const account = config.postex.accounts.find((a) => a.key === accountKey);
  if (!account) throw new Error(`No PostEx account configured for "${accountKey}"`);
  const client = new PostexClient(account);
  clients.set(accountKey, client);
  return client;
};

export const postexClients = (): PostexClient[] => config.postex.accounts.map((a) => postexClient(a.key));
