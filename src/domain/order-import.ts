import { createHash } from 'node:crypto';

import type { Sql } from '../db.js';
import { upsertAddress, upsertCustomer } from '../db/repos/customers.js';
import { recomputeOrderState } from '../db/repos/order-state.js';
import { type OrderInput, upsertOrder } from '../db/repos/orders.js';
import { atomically } from '../db/repos/upsert.js';
import { postexTrackingFromNote } from '../integrations/shopify/mapper.js';
import { type MatchCounts, matchUnmatched } from '../jobs/postex-match.js';
import { parseCsv } from '../lib/csv.js';
import { type Paisa, ZERO, fromRupeeString, paisa, sub } from '../lib/money.js';
import { parsePostexLocal } from '../lib/time.js';
import { postShipmentAccounting } from './accounting.js';
import { reconcileShipmentStock } from './stock.js';

/**
 * Order history from a store's Shopify order export CSV (Step 16): everything older than the
 * API's 60-day window. Orders go into the same tables as API orders, with source `csv_import`
 * and the same key (store, Shopify order id), so an order in both is one row:
 *
 * - an order the API already stored is left exactly as it is (the API wins);
 * - an order imported earlier is updated from the file, or left alone if nothing differs;
 * - the API sync, when it meets an imported order, overwrites it and makes it `api`.
 *
 * The columns are declared in `EXPORT_COLUMNS`, by Shopify's header names, never inferred.
 * Shopify writes one row per line item; order-level fields are on an order's first row only.
 * An order with any malformed row is skipped and reported with its row numbers; the rest of the
 * file is imported. Dry run first, then commit, as for partner sheets (T18). After a commit the
 * T05 matcher runs over every still-unmatched parcel of the store's PostEx accounts, so
 * pre-window parcels find their orders.
 */

/** Our field → the header in Shopify's order export. */
export const EXPORT_COLUMNS = {
  shopifyOrderId: 'Id',
  orderNumber: 'Name',
  createdAt: 'Created at',
  financialStatus: 'Financial Status',
  fulfillmentStatus: 'Fulfillment Status',
  subtotal: 'Subtotal',
  shipping: 'Shipping',
  taxes: 'Taxes',
  total: 'Total',
  discountCode: 'Discount Code',
  discountAmount: 'Discount Amount',
  cancelledAt: 'Cancelled at',
  tags: 'Tags',
  notes: 'Notes',
  phone: 'Phone',
  shippingPhone: 'Shipping Phone',
  billingPhone: 'Billing Phone',
  shippingName: 'Shipping Name',
  billingName: 'Billing Name',
  address1: 'Shipping Address1',
  address2: 'Shipping Address2',
  city: 'Shipping City',
  province: 'Shipping Province',
  zip: 'Shipping Zip',
  country: 'Shipping Country',
  lineQty: 'Lineitem quantity',
  lineName: 'Lineitem name',
  linePrice: 'Lineitem price',
  lineSku: 'Lineitem sku',
  lineDiscount: 'Lineitem discount',
} as const;

type Field = keyof typeof EXPORT_COLUMNS;
const REQUIRED: readonly Field[] = ['shopifyOrderId', 'orderNumber', 'createdAt', 'total', 'lineQty', 'lineName', 'linePrice'];

export interface Problem {
  /** The line in the file, header being line 1. */
  row: number;
  orderNumber: string | null;
  reason: string;
}

export interface ParsedOrder {
  orderNumber: string;
  rows: number[];
  input: Omit<OrderInput, 'storeId' | 'customerId' | 'shippingAddressId'>;
  customer: { name: string | null; phone: string | null };
  address: { line1: string | null; line2: string | null; city: string | null; province: string | null; postal: string | null; country: string | null } | null;
}

export interface ParsedFile {
  fileSha256: string;
  fileErrors: string[];
  rowsTotal: number;
  orders: ParsedOrder[];
  problems: Problem[];
  /** Orders skipped because a row of theirs is malformed. */
  malformedOrders: number;
}

export const fileHash = (csv: string): string => createHash('sha256').update(csv.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimEnd()).digest('hex');

/** `2026-03-14 18:22:07 +0500` as Shopify writes it; without an offset, Karachi time. */
export const parseShopifyTime = (text: string): Date | null => {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}:?\d{2}|Z)?$/.exec(text.trim());
  if (!m) return null;
  const time = m[2]!.length === 5 ? `${m[2]}:00` : m[2]!;
  try {
    if (!m[3]) return parsePostexLocal(`${m[1]} ${time}`);
    const offset = m[3] === 'Z' ? 'Z' : `${m[3].slice(0, 3)}:${m[3].slice(-2)}`;
    // Throws for a day that does not exist (2026-02-30), which Date would roll over instead.
    parsePostexLocal(`${m[1]} 00:00:00`);
    const date = new Date(`${m[1]}T${time}${offset}`);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
};

const blank = (v: string | undefined): string | null => (v && v.trim() !== '' ? v.trim() : null);

/**
 * Parses and checks a whole export against the declared columns. Reads no database and writes
 * nothing. Every problem is reported with its row; an order with any problem is set aside whole,
 * so a half-read order is never stored.
 */
export const parseExport = (csv: string): ParsedFile => {
  const fileSha256 = fileHash(csv);
  const empty = { fileSha256, rowsTotal: 0, orders: [], problems: [], malformedOrders: 0 };
  let table;
  try {
    table = parseCsv(csv);
  } catch (error) {
    return { ...empty, fileErrors: [(error as Error).message] };
  }
  const [header, ...body] = table;
  const columns = (header?.cells ?? []).map((c) => c.trim().toLowerCase());
  const index = (field: Field) => columns.indexOf(EXPORT_COLUMNS[field].toLowerCase());
  const missing = REQUIRED.filter((f) => index(f) < 0).map((f) => EXPORT_COLUMNS[f]);
  if (!header || missing.length > 0) {
    return { ...empty, fileErrors: [`Not a Shopify order export: missing column${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`] };
  }
  const get = (cells: string[], field: Field): string | null => {
    const i = index(field);
    return i < 0 ? null : blank(cells[i]);
  };

  // Rows by order number, in file order. Shopify writes an order's rows together; reading by
  // number also copes with a file someone sorted.
  const byOrder = new Map<string, Array<{ line: number; cells: string[] }>>();
  const problems: Problem[] = [];
  let rowsTotal = 0;
  for (const row of body) {
    if (row.cells.every((c) => c.trim() === '')) continue;
    rowsTotal++;
    const name = get(row.cells, 'orderNumber');
    if (!name) {
      problems.push({ row: row.line, orderNumber: null, reason: 'Name (the order number) is empty' });
      continue;
    }
    byOrder.set(name, [...(byOrder.get(name) ?? []), row]);
  }

  const orders: ParsedOrder[] = [];
  let malformedOrders = 0;
  for (const [orderNumber, rows] of byOrder) {
    const issues: Problem[] = [];
    const issue = (row: number, reason: string) => issues.push({ row, orderNumber, reason });
    const amount = (row: number, field: Field, text: string | null, optional: boolean): Paisa => {
      if (text === null) {
        if (!optional) issue(row, `${EXPORT_COLUMNS[field]} is empty`);
        return ZERO;
      }
      try {
        const value = fromRupeeString(text);
        if (value < 0n) issue(row, `${EXPORT_COLUMNS[field]} "${text}" is negative`);
        return value;
      } catch {
        issue(row, `${EXPORT_COLUMNS[field]} "${text}" is not an amount`);
        return ZERO;
      }
    };

    // Order-level fields live on the row that has them, normally the first.
    const head = rows.find((r) => get(r.cells, 'shopifyOrderId') !== null) ?? rows[0]!;
    const h = head.cells;
    const idText = get(h, 'shopifyOrderId');
    if (!idText) issue(head.line, 'Id (the Shopify order id) is empty');
    else if (!/^\d{1,19}$/.test(idText)) issue(head.line, `Id "${idText}" is not a Shopify order id`);
    const created = get(h, 'createdAt');
    const placedAt = created ? parseShopifyTime(created) : null;
    if (!created) issue(head.line, 'Created at is empty');
    else if (!placedAt) issue(head.line, `Created at "${created}" is not a date and time`);
    const cancelledText = get(h, 'cancelledAt');
    const cancelledAt = cancelledText ? parseShopifyTime(cancelledText) : null;
    if (cancelledText && !cancelledAt) issue(head.line, `Cancelled at "${cancelledText}" is not a date and time`);
    const ids = new Set(rows.map((r) => get(r.cells, 'shopifyOrderId')).filter((x): x is string => x !== null));
    if (ids.size > 1) issue(head.line, `rows of ${orderNumber} carry different Ids: ${[...ids].join(', ')}`);

    const total = amount(head.line, 'total', get(h, 'total'), false);
    const subtotal = amount(head.line, 'subtotal', get(h, 'subtotal'), true);
    const shipping = amount(head.line, 'shipping', get(h, 'shipping'), true);
    const tax = amount(head.line, 'taxes', get(h, 'taxes'), true);
    const discount = amount(head.line, 'discountAmount', get(h, 'discountAmount'), true);

    const lines: OrderInput['lines'] = [];
    for (const [i, r] of rows.entries()) {
      const title = get(r.cells, 'lineName');
      const qtyText = get(r.cells, 'lineQty');
      if (!title) issue(r.line, 'Lineitem name is empty');
      if (!qtyText || !/^\d+$/.test(qtyText)) issue(r.line, `Lineitem quantity "${qtyText ?? ''}" is not a whole number`);
      const qty = qtyText && /^\d+$/.test(qtyText) ? Number(qtyText) : 0;
      const price = amount(r.line, 'linePrice', get(r.cells, 'linePrice'), false);
      const lineDiscount = amount(r.line, 'lineDiscount', get(r.cells, 'lineDiscount'), true);
      const gross = paisa(price * BigInt(qty));
      lines.push({
        lineKey: `line:${i + 1}`,
        variantId: null,
        sku: get(r.cells, 'lineSku'),
        title: title ?? '',
        qty,
        unitPrice: price,
        discount: lineDiscount,
        total: lineDiscount > gross ? ZERO : sub(gross, lineDiscount),
      });
    }

    if (issues.length > 0) {
      problems.push(...issues);
      malformedOrders++;
      continue;
    }
    const tags = (get(h, 'tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const financial = get(h, 'financialStatus')?.toLowerCase() ?? null;
    const fulfillment = get(h, 'fulfillmentStatus')?.toLowerCase() ?? null;
    const city = get(h, 'city');
    const line1 = get(h, 'address1');
    orders.push({
      orderNumber,
      rows: rows.map((r) => r.line),
      input: {
        shopifyOrderId: BigInt(idText!),
        orderNumber,
        placedAt: placedAt!,
        financialStatus: financial,
        fulfillmentStatus: fulfillment,
        subtotal,
        discount,
        shipping,
        tax,
        total,
        channel: tags.some((t) => t.toUpperCase() === 'PR') ? 'pr' : 'online',
        cancelledAt,
        cancelReason: null,
        tags,
        discountCodes: (get(h, 'discountCode') ?? '').split(',').map((c) => c.trim()).filter(Boolean),
        postexTrackingNumbers: postexTrackingFromNote(get(h, 'notes')),
        source: 'csv_import',
        // Where the row came from, not what it said: the typed columns hold the order, and a
        // copy of the CSV row would put names and addresses where redaction does not look.
        raw: { source: 'csv_import', fileSha256, rows: rows.map((r) => r.line) },
        lines,
      },
      customer: { name: get(h, 'shippingName') ?? get(h, 'billingName'), phone: get(h, 'shippingPhone') ?? get(h, 'phone') ?? get(h, 'billingPhone') },
      address:
        line1 || city
          ? { line1, line2: get(h, 'address2'), city, province: get(h, 'province'), postal: get(h, 'zip'), country: get(h, 'country') }
          : null,
    });
  }
  return { fileSha256, fileErrors: [], rowsTotal, orders, problems: problems.sort((a, b) => a.row - b.row), malformedOrders };
};

export interface ImportReport {
  fileSha256: string;
  fileErrors: string[];
  rowsTotal: number;
  problems: Problem[];
  orders: {
    valid: number;
    malformed: number;
    /** New to the database. */
    new: number;
    /** Imported before; the file may update them. */
    previouslyImported: number;
    /** Already stored from the API, which wins: left as they are. */
    fromApi: number;
    /** The order number belongs to a different Shopify order in this store. */
    conflicting: number;
  };
}

interface Existing {
  id: string;
  shopify_order_id: string | null;
  order_number: string;
  source: string;
}

const existingOrders = async (db: Sql, storeId: string, orders: ParsedOrder[]): Promise<Existing[]> =>
  db<Existing[]>`
    select id, shopify_order_id::text, order_number, source from orders
    where store_id = ${storeId}
      and (shopify_order_id = any(${orders.map((o) => o.input.shopifyOrderId!.toString())}::bigint[]) or order_number = any(${orders.map((o) => o.orderNumber)}::text[]))
  `;

type Fate = 'new' | 'previouslyImported' | 'fromApi' | 'conflicting';

const fateOf = (order: ParsedOrder, existing: Existing[]): { fate: Fate; reason?: string } => {
  const byId = existing.find((e) => e.shopify_order_id === order.input.shopifyOrderId!.toString());
  if (byId) return { fate: byId.source === 'api' ? 'fromApi' : 'previouslyImported' };
  const byNumber = existing.find((e) => e.order_number === order.orderNumber);
  if (byNumber) return { fate: 'conflicting', reason: `${order.orderNumber} is already order ${byNumber.shopify_order_id ?? byNumber.id} in this store, a different Shopify order` };
  return { fate: 'new' };
};

const storeIdOf = async (sql: Sql, store: 'nur' | 'organics'): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`select id from stores where key = ${store}`;
  if (!row) throw new Error(`Store ${store} is not set up`);
  return row.id;
};

/** The dry run: what a commit would do, order by order. Reads only. */
export const dryRunOrderImport = async (sql: Sql, store: 'nur' | 'organics', csv: string): Promise<ImportReport> => {
  const parsed = parseExport(csv);
  const storeId = await storeIdOf(sql, store);
  const existing = parsed.orders.length > 0 ? await existingOrders(sql, storeId, parsed.orders) : [];
  const counts = { new: 0, previouslyImported: 0, fromApi: 0, conflicting: 0 };
  const problems = [...parsed.problems];
  for (const order of parsed.orders) {
    const { fate, reason } = fateOf(order, existing);
    counts[fate]++;
    if (reason) problems.push({ row: order.rows[0]!, orderNumber: order.orderNumber, reason });
  }
  return {
    fileSha256: parsed.fileSha256,
    fileErrors: parsed.fileErrors,
    rowsTotal: parsed.rowsTotal,
    problems: problems.sort((a, b) => a.row - b.row),
    orders: { valid: parsed.orders.length - counts.conflicting, malformed: parsed.malformedOrders, ...counts },
  };
};

export interface CommitReport extends ImportReport {
  importId: string;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Pre-window parcels the matcher linked to an order once the history was in. */
  parcelsMatched: number;
}

/**
 * Stores every well-formed order of the file that the API has not already stored, each in its own
 * transaction, then runs the matcher. A malformed order or one that fails to store is reported
 * and skipped; it never stops the rest.
 */
export const commitOrderImport = async (
  sql: Sql,
  input: { store: 'nur' | 'organics'; fileName: string; csv: string; actorId: string },
  /** Called as each order is stored, then as each parcel is matched, for a script's progress bar. */
  onProgress?: (stage: 'orders' | 'matching', done: number, total: number) => void,
): Promise<CommitReport> => {
  const report = await dryRunOrderImport(sql, input.store, input.csv);
  if (report.fileErrors.length > 0) return { ...report, importId: '', inserted: 0, updated: 0, unchanged: 0, parcelsMatched: 0 };
  const parsed = parseExport(input.csv);
  const storeId = await storeIdOf(sql, input.store);
  const variants = new Map(
    (await sql<{ id: string; sku: string }[]>`select id, lower(trim(sku)) as sku from variants where store_id = ${storeId} and sku is not null and deleted_at is null`).map((v) => [v.sku, v.id]),
  );
  const problems = [...report.problems];
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let processed = 0;
  for (const order of parsed.orders) {
    onProgress?.('orders', processed++, parsed.orders.length);
    try {
      const result = await atomically(sql, async (tx) => {
        // Decided inside the transaction: the API sync may have stored the order meanwhile.
        const { fate } = fateOf(order, await existingOrders(tx as Sql, storeId, [order]));
        if (fate === 'fromApi' || fate === 'conflicting') return null;
        const customer = await upsertCustomer(tx, { storeId, shopifyCustomerId: null, name: order.customer.name, phone: order.customer.phone, shopifyOrderId: order.input.shopifyOrderId });
        const address = customer && order.address ? await upsertAddress(tx, customer.id, order.address) : null;
        const stored = await upsertOrder(tx, {
          ...order.input,
          storeId,
          customerId: customer?.id ?? null,
          shippingAddressId: address?.id ?? null,
          lines: order.input.lines.map((l) => ({ ...l, variantId: (l.sku && variants.get(l.sku.trim().toLowerCase())) || null })),
        });
        await recomputeOrderState(tx, stored.id);
        return stored;
      });
      if (!result) continue;
      if (result.action === 'inserted') inserted++;
      else if (result.changed) updated++;
      else unchanged++;
    } catch (error) {
      problems.push({ row: order.rows[0]!, orderNumber: order.orderNumber, reason: `could not be stored: ${(error as Error).message}` });
    }
  }

  onProgress?.('orders', parsed.orders.length, parsed.orders.length);

  // Pre-window parcels that had no order to match until now.
  const counts: MatchCounts = { matched: 0, suggested: 0, unmatched: 0 };
  const accounts = await sql<{ id: string; key: string }[]>`select id, key from postex_accounts where store_id = ${storeId} order by id`;
  for (const account of accounts) {
    const matched = await matchUnmatched(sql, account, counts);
    let relinked = 0;
    for (const shipmentId of matched) {
      onProgress?.('matching', relinked++, matched.length);
      const stock = await reconcileShipmentStock(sql, shipmentId);
      if (stock.orderId) await recomputeOrderState(sql, stock.orderId);
      await postShipmentAccounting(sql, shipmentId);
    }
  }

  const [run] = await sql<{ id: string }[]>`
    insert into order_csv_imports (store_id, file_name, file_sha256, rows_total, orders_inserted, orders_updated, orders_unchanged,
                                   orders_api_kept, orders_malformed, parcels_matched, imported_by)
    values (${storeId}, ${input.fileName}, ${report.fileSha256}, ${report.rowsTotal}, ${inserted}, ${updated}, ${unchanged},
            ${report.orders.fromApi}, ${report.orders.malformed}, ${counts.matched}, ${input.actorId})
    returning id
  `;
  await sql`
    insert into audit_log (actor_id, action, entity, entity_id, after)
    values (${input.actorId}, 'orders.csv_import', 'order_csv_imports', ${run!.id},
            ${sql.json({ store: input.store, fileName: input.fileName, inserted, updated, unchanged, fromApi: report.orders.fromApi, malformed: report.orders.malformed, parcelsMatched: counts.matched })})
  `;
  return { ...report, problems: problems.sort((a, b) => a.row - b.row), importId: run!.id, inserted, updated, unchanged, parcelsMatched: counts.matched };
};
