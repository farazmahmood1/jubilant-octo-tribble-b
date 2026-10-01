import type { Sql } from '../db.js';
import { openReviewItem, resolveOpenReviewItem } from '../db/repos/review.js';
import { atomically, readPaisa } from '../db/repos/upsert.js';
import { DEFAULT_WINDOW_DAYS, type OrderCandidate, explainMatch, parseOrderRef } from '../domain/matching.js';

/**
 * Links PostEx parcels to Shopify orders (Step 6), using the T05 matcher. Runs inside
 * `postex:sync` after each account's parcels are stored.
 *
 * Only parcels with no order are looked at, so a manual link is never overridden and a parcel
 * matched once is not re-matched. A link by order number is certain; a fallback link (COD amount
 * and city, or phone, within the booking window) is made only on a single candidate (risk R6)
 * and also opens an info item for a person to glance at. Every parcel still unmatched has an
 * open `unmatched_shipment` item saying why; it is resolved when a later run finds the order.
 */

export const UNMATCHED_KIND = 'unmatched_shipment';
export const SUGGESTED_KIND = 'match_suggested';

/** `app_settings` key `matching`: `{ "refPrefixes": { "<store key>": ["NBJ"] }, "windowDays": 3 }`. */
interface MatchingSettings {
  refPrefixes?: Record<string, string[]>;
  windowDays?: number;
}

export interface MatchCounts {
  matched: number;
  suggested: number;
  unmatched: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const settings = async (sql: Sql): Promise<MatchingSettings> => {
  const [row] = await sql<{ value: MatchingSettings }[]>`select value from app_settings where key = 'matching'`;
  return row?.value ?? {};
};

/**
 * The orders that could own one parcel: this store's orders placed in the booking window, plus
 * any whose number equals the parcel's reference wherever it falls. The matcher decides; this
 * only keeps it from reading the whole store.
 */
export const candidatesFor = async (
  sql: Sql,
  storeId: string,
  parcel: { orderRef: string | null; bookedAt: Date | null },
  windowDays: number,
): Promise<OrderCandidate[]> => {
  const ref = parseOrderRef(parcel.orderRef)?.number ?? null;
  const from = parcel.bookedAt ? new Date(parcel.bookedAt.getTime() - (windowDays + 1) * DAY_MS) : null;
  const to = parcel.bookedAt ? new Date(parcel.bookedAt.getTime() + DAY_MS) : null;
  if (ref === null && from === null) return [];
  const rows = await sql<{ id: string; name: string; total: string; city: string | null; phone: string | null; placed_at: Date }[]>`
    select o.id, o.order_number as name, o.total_paisa::text as total, a.city, c.phone_e164 as phone, o.placed_at
    from orders o
    left join addresses a on a.id = o.shipping_address_id
    left join customers c on c.id = o.customer_id
    where o.store_id = ${storeId}
      and (
        (${ref}::text is not null and ltrim(regexp_replace(o.order_number, '\\D', '', 'g'), '0') = ltrim(${ref}::text, '0'))
        or (${from}::timestamptz is not null and o.placed_at between ${from}::timestamptz and ${to}::timestamptz)
      )
  `;
  return rows.map((r) => ({ id: r.id, storeId, name: r.name, codAmount: readPaisa(r.total), city: r.city, phone: r.phone, placedAt: r.placed_at }));
};

/** Tries every unmatched parcel of one account. Returns the ids it linked. */
export const matchUnmatched = async (
  sql: Sql,
  account: { id: string; key: string },
  counts: MatchCounts,
): Promise<string[]> => {
  const [acct] = await sql<{ store_id: string | null; store_key: string | null }[]>`
    select a.store_id, s.key as store_key from postex_accounts a left join stores s on s.id = a.store_id where a.id = ${account.id}
  `;
  const storeId = acct?.store_id ?? null;
  const config = await settings(sql);
  const windowDays = config.windowDays ?? DEFAULT_WINDOW_DAYS;
  const refPrefixes = (acct?.store_key && config.refPrefixes?.[acct.store_key]) || [];

  const parcels = await sql<
    { id: string; tracking_number: string; order_ref_number: string | null; cod: string | null; city: string | null; customer_phone: string | null; booked_at: Date | null }[]
  >`
    select id, tracking_number, order_ref_number, cod_amount_paisa::text as cod, city, customer_phone, booked_at
    from shipments where postex_account_id = ${account.id} and order_id is null
    order by id
  `;

  const linked: string[] = [];
  for (const parcel of parcels) {
    const candidates = storeId ? await candidatesFor(sql, storeId, { orderRef: parcel.order_ref_number, bookedAt: parcel.booked_at }, windowDays) : [];
    const explanation = explainMatch(
      {
        orderRefNumber: parcel.order_ref_number,
        codAmount: parcel.cod === null ? null : readPaisa(parcel.cod),
        city: parcel.city,
        customerPhone: parcel.customer_phone,
        bookedAt: parcel.booked_at,
      },
      candidates,
      { storeId, windowDays, refPrefixes },
    );
    const unmatchedKey = `${UNMATCHED_KIND}:${parcel.id}`;
    const { match } = explanation;

    if (!match) {
      counts.unmatched++;
      await openReviewItem(sql, {
        kind: UNMATCHED_KIND,
        dedupeKey: unmatchedKey,
        storeId,
        shipmentId: parcel.id,
        detail: {
          account: account.key,
          trackingNumber: parcel.tracking_number,
          orderRefNumber: parcel.order_ref_number,
          reason: explanation.reason,
          tiedOrderIds: explanation.tiedOrderIds,
        },
      });
      continue;
    }

    await atomically(sql, async (tx) => {
      await tx`
        update shipments set order_id = ${match.orderId}, match_method = ${match.method}, match_confidence = ${match.confidence}, stock_pending = true
        where id = ${parcel.id} and order_id is null
      `;
      await resolveOpenReviewItem(tx, unmatchedKey, `Matched by ${match.method}`);
      if (match.method !== 'order_ref') {
        await openReviewItem(tx, {
          kind: SUGGESTED_KIND,
          dedupeKey: `${SUGGESTED_KIND}:${parcel.id}`,
          severity: 'info',
          storeId,
          orderId: match.orderId,
          shipmentId: parcel.id,
          detail: { account: account.key, trackingNumber: parcel.tracking_number, method: match.method, confidence: match.confidence },
        });
      }
    });
    counts.matched++;
    if (match.method !== 'order_ref') counts.suggested++;
    linked.push(parcel.id);
  }
  return linked;
};
