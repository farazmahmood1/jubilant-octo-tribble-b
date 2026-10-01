import { costRecorded } from '../db/repos/costs.js';
import { type Db, atomically, big, readPaisa } from '../db/repos/upsert.js';
import { costAt } from '../db/repos/variants.js';
import { type Paisa, ZERO, add, paisa, sub, sum } from '../lib/money.js';
import { endOfKarachiDay, formatKarachi, startOfKarachiDate } from '../lib/time.js';
import { PeriodClosedError, goodsReceiptLines, karachiDay, postEntry, purchaseBillLines, vendorPaymentLines } from './accounting.js';
import { formatRupees } from './confirmation.js';
import { locationId, recordMove } from './stock.js';

/**
 * Purchasing (BUILD-PLAN Batch F, proposal 6.1): request → quotations → purchase order → goods
 * receipt → vendor bill → payment.
 *
 * | Step            | Writes                                                                                     |
 * |-----------------|--------------------------------------------------------------------------------------------|
 * | Request         | `purchase_requests`                                                                        |
 * | Quotation       | `quotations`, `quotation_lines`                                                            |
 * | Purchase order  | `purchase_orders`, `po_lines` (one brand per order)                                         |
 * | Goods receipt   | `goods_receipts`, `gr_lines`; a `supplier → warehouse` stock move per line; a `product_costs` row per product; Dr Inventory / Cr Goods received not billed |
 * | Vendor bill     | `vendor_bills`, `bill_lines`, after the three-way match; Dr Goods received not billed, price variance, charges, input tax / Cr Accounts payable |
 * | Payment         | `vendor_payments`, after the three-way match again; Dr Accounts payable / Cr Bank          |
 *
 * Every step is one transaction, audited with the person who did it (rule 8).
 *
 * **The cost a receipt writes** is the moving average of what the brand already holds and what
 * arrived: (units held × current cost + units received × order price) ÷ all units, rounded to the
 * paisa. With nothing held it is the order price. It is dated on the receipt's Karachi day, and
 * a parcel's COGS uses the cost in force on its order date (`costAt`), so the next sale after a
 * receipt is costed at it. Units held × cost then stays equal to the Inventory account.
 *
 * **Three-way match.** For each order line on a bill, with every bill so far: units billed may
 * not exceed units received, and the amount billed may exceed the received units at the order's
 * price by at most the tolerance (`purchasing` setting: the larger of `tolerancePercent` of it
 * and `toleranceAbsolutePaisa`). A bill that fails is refused; a payment against a bill that no
 * longer matches (the tolerance was tightened) is refused too.
 */

export class PurchaseError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409 = 409) {
    super(message);
    this.name = 'PurchaseError';
    this.status = status;
  }
}

export interface PurchasingSettings {
  tolerancePercent: number;
  /** Paisa. */
  toleranceAbsolutePaisa: number;
  /** Days of delivered sales the reorder velocity is measured over. */
  velocityWindowDays: number;
  /** Days of sales a reorder should cover after it arrives. */
  coverDays: number;
  /** When a vendor has no lead time of its own. */
  defaultLeadTimeDays: number;
}

export const DEFAULT_PURCHASING: PurchasingSettings = {
  tolerancePercent: 2,
  toleranceAbsolutePaisa: 10_000,
  velocityWindowDays: 30,
  coverDays: 30,
  defaultLeadTimeDays: 7,
};

export const purchasingSettings = async (db: Db): Promise<PurchasingSettings> => {
  const [row] = await db<{ value: Partial<PurchasingSettings> }[]>`select value from app_settings where key = 'purchasing'`;
  return { ...DEFAULT_PURCHASING, ...(row?.value ?? {}) };
};

const audit = (db: Db, actorId: string, action: string, entity: string, entityId: string, after: Record<string, unknown>) =>
  db`
    insert into audit_log (actor_id, action, entity, entity_id, after)
    values (${actorId}, ${action}, ${entity}, ${entityId}, ${db.json(after as never)})
  `;

const asConflict = (message: string) => (error: unknown): never => {
  if (error instanceof Error && 'code' in error && (error as { code?: string }).code === '23505') throw new PurchaseError(message);
  throw error;
};

const asPeriod = (error: unknown): never => {
  if (error instanceof PeriodClosedError) throw new PurchaseError(error.message);
  throw error;
};

// ---- Pure rules ----

/** The moving-average cost after a receipt, rounded half-up to the paisa. */
export const movingAverageCost = (held: number, current: Paisa | null, received: number, price: Paisa): Paisa => {
  if (held <= 0 || current === null) return price;
  const units = BigInt(held + received);
  const value = BigInt(held) * current + BigInt(received) * price;
  return paisa((2n * value + units) / (2n * units));
};

/** How far over the received value a bill may go: the larger of the percentage and the floor. */
export const allowance = (receivedValue: Paisa, s: Pick<PurchasingSettings, 'tolerancePercent' | 'toleranceAbsolutePaisa'>): Paisa => {
  // Basis points keep a fractional percentage (2.5%) exact.
  const percent = (receivedValue * BigInt(Math.round(s.tolerancePercent * 100))) / 10_000n;
  const floor = BigInt(s.toleranceAbsolutePaisa);
  return paisa(percent > floor ? percent : floor);
};

export interface MatchLine {
  poLineId: string;
  title: string;
  unitCost: Paisa;
  received: number;
  /** Earlier bills on this line. */
  billedQty: number;
  billedValue: Paisa;
  /** This bill: units, and their amount exactly as billed. */
  qty: number;
  value: Paisa;
}

/**
 * The three-way match: order (price), receipts (units) and bills (units and amount). Returns one
 * sentence per line that fails, empty when the bill matches.
 */
export const threeWayMatch = (lines: readonly MatchLine[], s: Pick<PurchasingSettings, 'tolerancePercent' | 'toleranceAbsolutePaisa'>): string[] =>
  lines.flatMap((l) => {
    const units = l.billedQty + l.qty;
    if (units > l.received) {
      return [`${l.title}: ${units} units billed${l.billedQty ? ` (${l.billedQty} on earlier bills)` : ''}, but only ${l.received} received`];
    }
    const billed = add(l.billedValue, l.value);
    const receivedValue = paisa(BigInt(units) * l.unitCost);
    const allowed = allowance(receivedValue, s);
    if (billed - receivedValue <= allowed) return [];
    return [
      `${l.title}: ${formatRupees(billed)} billed for ${units} units received at the order's ${formatRupees(l.unitCost)} (${formatRupees(receivedValue)}): ` +
        `over by ${formatRupees(sub(billed, receivedValue))}, more than the ${formatRupees(allowed)} tolerance`,
    ];
  });

export interface ReorderFacts {
  variantId: string;
  /** Units delivered to customers in the window, net of customer returns. */
  delivered: number;
  windowDays: number;
  warehouse: number;
  onOrder: number;
  leadTimeDays: number;
  coverDays: number;
}

/**
 * What to order now: enough to cover the lead time and the cover period at the delivered rate,
 * less what is on the shelf and already on order. Never negative.
 */
export const reorderQty = (f: ReorderFacts): number => {
  if (f.delivered <= 0) return 0;
  const need = Math.ceil((f.delivered * (f.leadTimeDays + f.coverDays)) / f.windowDays);
  return Math.max(0, need - Math.max(0, f.warehouse) - f.onOrder);
};

// ---- Vendors ----

export interface VendorInput {
  name: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  leadTimeDays?: number | null;
  paymentTermsDays?: number | null;
  notes?: string | null;
  isActive?: boolean;
}

export const createVendor = async (db: Db, input: VendorInput, actorId: string): Promise<string> =>
  atomically(db, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into vendors (name, contact_name, phone, email, city, lead_time_days, payment_terms_days, notes, is_active)
      values (${input.name}, ${input.contactName ?? null}, ${input.phone ?? null}, ${input.email ?? null}, ${input.city ?? null},
              ${input.leadTimeDays ?? null}, ${input.paymentTermsDays ?? null}, ${input.notes ?? null}, ${input.isActive ?? true})
      returning id
    `.catch(asConflict(`A vendor called ${input.name} already exists`));
    await audit(tx, actorId, 'vendor.create', 'vendors', row!.id, { ...input });
    return row!.id;
  });

const VENDOR_COLUMNS = {
  name: 'name',
  contactName: 'contact_name',
  phone: 'phone',
  email: 'email',
  city: 'city',
  leadTimeDays: 'lead_time_days',
  paymentTermsDays: 'payment_terms_days',
  notes: 'notes',
  isActive: 'is_active',
} as const;

export const updateVendor = async (db: Db, id: string, input: Partial<VendorInput>, actorId: string): Promise<void> =>
  atomically(db, async (tx) => {
    const changes = Object.fromEntries(
      Object.entries(input)
        .filter(([key, value]) => value !== undefined && key in VENDOR_COLUMNS)
        .map(([key, value]) => [VENDOR_COLUMNS[key as keyof typeof VENDOR_COLUMNS], value]),
    );
    const [found] = await tx`select 1 from vendors where id = ${id} for update`;
    if (!found) throw new PurchaseError(`Vendor ${id} not found`, 404);
    if (Object.keys(changes).length === 0) return;
    await tx`update vendors set ${tx(changes)} where id = ${id}`.catch(asConflict(`A vendor called ${input.name ?? ''} already exists`));
    await audit(tx, actorId, 'vendor.update', 'vendors', id, { ...input });
  });

export interface VendorRow {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  leadTimeDays: number | null;
  paymentTermsDays: number | null;
  notes: string | null;
  isActive: boolean;
  /** What we owe the vendor now, from Accounts payable (paisa). */
  payable: Paisa;
  /** Received and not yet billed (paisa). */
  receivedNotBilled: Paisa;
}

export const listVendors = async (db: Db): Promise<VendorRow[]> => {
  const rows = await db<{
    id: string; name: string; contact_name: string | null; phone: string | null; email: string | null; city: string | null;
    lead_time_days: number | null; payment_terms_days: number | null; notes: string | null; is_active: boolean; payable: string; grni: string;
  }[]>`
    select v.*, coalesce(b.payable, 0)::text as payable, coalesce(b.grni, 0)::text as grni
    from vendors v
    left join (
      select l.partner_id,
             sum(l.credit_paisa - l.debit_paisa) filter (where a.code = '2000') as payable,
             sum(l.credit_paisa - l.debit_paisa) filter (where a.code = '2050') as grni
      from journal_lines l join accounts a on a.id = l.account_id
      where l.partner_type = 'vendor' group by l.partner_id
    ) b on b.partner_id = v.id
    order by v.is_active desc, lower(v.name)
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    contactName: r.contact_name,
    phone: r.phone,
    email: r.email,
    city: r.city,
    leadTimeDays: r.lead_time_days,
    paymentTermsDays: r.payment_terms_days,
    notes: r.notes,
    isActive: r.is_active,
    payable: readPaisa(r.payable),
    receivedNotBilled: readPaisa(r.grni),
  }));
};

// ---- Step 1: requests ----

export const createRequest = async (db: Db, input: { variantId: string; qty: number; reason?: string | null; actorId: string }): Promise<string> =>
  atomically(db, async (tx) => {
    const [variant] = await tx`select 1 from variants where id = ${input.variantId} and deleted_at is null`;
    if (!variant) throw new PurchaseError(`Product ${input.variantId} not found`, 404);
    const [row] = await tx<{ id: string }[]>`
      insert into purchase_requests (variant_id, qty, reason, requested_by) values (${input.variantId}, ${input.qty}, ${input.reason ?? null}, ${input.actorId})
      returning id
    `;
    await audit(tx, input.actorId, 'purchase_request.create', 'purchase_requests', row!.id, { variantId: input.variantId, qty: input.qty, reason: input.reason ?? null });
    return row!.id;
  });

export const cancelRequest = async (db: Db, id: string, actorId: string): Promise<void> =>
  atomically(db, async (tx) => {
    const [row] = await tx<{ cancelled_at: Date | null; ordered: boolean }[]>`
      select r.cancelled_at,
             exists (select 1 from po_lines pl join purchase_orders po on po.id = pl.po_id where pl.purchase_request_id = r.id and po.cancelled_at is null) as ordered
      from purchase_requests r where r.id = ${id} for update
    `;
    if (!row) throw new PurchaseError(`Request ${id} not found`, 404);
    if (row.cancelled_at) throw new PurchaseError('The request is already cancelled');
    if (row.ordered) throw new PurchaseError('The request is on a purchase order; cancel the order instead');
    await tx`update purchase_requests set cancelled_at = now(), cancelled_by = ${actorId} where id = ${id}`;
    await audit(tx, actorId, 'purchase_request.cancel', 'purchase_requests', id, {});
  });

export interface RequestRow {
  id: string;
  variantId: string;
  store: string;
  sku: string | null;
  title: string;
  qty: number;
  reason: string | null;
  requestedBy: string;
  requestedAt: Date;
  /** Derived: cancelled, on an order, quoted, or open. */
  status: 'cancelled' | 'ordered' | 'quoted' | 'open';
  quotes: number;
}

export const listRequests = async (db: Db, opts: { includeClosed?: boolean } = {}): Promise<RequestRow[]> => {
  const rows = await db<{
    id: string; variant_id: string; store: string; sku: string | null; title: string; qty: number; reason: string | null; requested_by: string;
    requested_at: Date; cancelled: boolean; ordered: boolean; quotes: number;
  }[]>`
    select r.id, r.variant_id, st.key as store, v.sku, p.title || ' · ' || v.title as title, r.qty, r.reason, u.name as requested_by, r.requested_at,
           r.cancelled_at is not null as cancelled,
           exists (select 1 from po_lines pl join purchase_orders po on po.id = pl.po_id where pl.purchase_request_id = r.id and po.cancelled_at is null) as ordered,
           (select count(*)::int from quotation_lines ql where ql.purchase_request_id = r.id) as quotes
    from purchase_requests r
    join variants v on v.id = r.variant_id join products p on p.id = v.product_id join stores st on st.id = v.store_id
    join users u on u.id = r.requested_by
    order by r.requested_at desc, r.id desc
  `;
  return rows
    .map((r): RequestRow => ({
      id: r.id,
      variantId: r.variant_id,
      store: r.store,
      sku: r.sku,
      title: r.title,
      qty: r.qty,
      reason: r.reason,
      requestedBy: r.requested_by,
      requestedAt: r.requested_at,
      status: r.cancelled ? 'cancelled' : r.ordered ? 'ordered' : r.quotes > 0 ? 'quoted' : 'open',
      quotes: r.quotes,
    }))
    .filter((r) => opts.includeClosed || r.status === 'open' || r.status === 'quoted');
};

// ---- Step 2: quotations ----

export interface QuotationInput {
  vendorId: string;
  receivedOn: string;
  validUntil?: string | null;
  reference?: string | null;
  note?: string | null;
  lines: Array<{ variantId: string; qty: number; unitPrice: Paisa; requestId?: string | null }>;
  actorId: string;
}

export const createQuotation = async (db: Db, input: QuotationInput): Promise<string> =>
  atomically(db, async (tx) => {
    const [vendor] = await tx`select 1 from vendors where id = ${input.vendorId}`;
    if (!vendor) throw new PurchaseError(`Vendor ${input.vendorId} not found`, 404);
    const [q] = await tx<{ id: string }[]>`
      insert into quotations (vendor_id, received_on, valid_until, reference, note, created_by)
      values (${input.vendorId}, ${input.receivedOn}, ${input.validUntil ?? null}, ${input.reference ?? null}, ${input.note ?? null}, ${input.actorId})
      returning id
    `;
    for (const line of input.lines) {
      if (line.requestId) {
        const [request] = await tx<{ variant_id: string }[]>`select variant_id from purchase_requests where id = ${line.requestId} and cancelled_at is null`;
        if (!request) throw new PurchaseError(`Request ${line.requestId} is not open`, 404);
        if (request.variant_id !== line.variantId) throw new PurchaseError(`Request ${line.requestId} is for another product`);
      }
      await tx`
        insert into quotation_lines (quotation_id, variant_id, purchase_request_id, qty, unit_price_paisa)
        values (${q!.id}, ${line.variantId}, ${line.requestId ?? null}, ${line.qty}, ${big(line.unitPrice)})
      `;
    }
    await audit(tx, input.actorId, 'quotation.create', 'quotations', q!.id, { vendorId: input.vendorId, lines: input.lines.length });
    return q!.id;
  });

export interface QuoteComparison {
  quotationId: string;
  quotationLineId: string;
  vendorId: string;
  vendor: string;
  receivedOn: string;
  validUntil: string | null;
  expired: boolean;
  qty: number;
  unitPrice: Paisa;
}

/** Every quote for a product, cheapest first; a quote past its validity is marked, not hidden. */
export const compareQuotes = async (db: Db, variantId: string, today: string): Promise<QuoteComparison[]> => {
  const rows = await db<{ quotation_id: string; line_id: string; vendor_id: string; vendor: string; received_on: string; valid_until: string | null; qty: number; price: string }[]>`
    select q.id as quotation_id, ql.id as line_id, q.vendor_id, v.name as vendor, q.received_on::text, q.valid_until::text, ql.qty, ql.unit_price_paisa::text as price
    from quotation_lines ql join quotations q on q.id = ql.quotation_id join vendors v on v.id = q.vendor_id
    where ql.variant_id = ${variantId}
    order by ql.unit_price_paisa, q.received_on desc, ql.id
  `;
  return rows.map((r) => ({
    quotationId: r.quotation_id,
    quotationLineId: r.line_id,
    vendorId: r.vendor_id,
    vendor: r.vendor,
    receivedOn: r.received_on,
    validUntil: r.valid_until,
    expired: r.valid_until !== null && r.valid_until < today,
    qty: r.qty,
    unitPrice: readPaisa(r.price),
  }));
};

// ---- Step 3: purchase orders ----

export interface PurchaseOrderInput {
  vendorId: string;
  store: 'nur' | 'organics';
  quotationId?: string | null;
  orderedOn: string;
  expectedOn?: string | null;
  note?: string | null;
  /** Taken from the quotation when left out. */
  lines?: Array<{ variantId: string; qty: number; unitCost: Paisa; requestId?: string | null }>;
  actorId: string;
}

export const createPurchaseOrder = async (db: Db, input: PurchaseOrderInput): Promise<{ id: string; number: string }> =>
  atomically(db, async (tx) => {
    const [vendor] = await tx<{ is_active: boolean }[]>`select is_active from vendors where id = ${input.vendorId}`;
    if (!vendor) throw new PurchaseError(`Vendor ${input.vendorId} not found`, 404);
    if (!vendor.is_active) throw new PurchaseError('The vendor is inactive');
    const [store] = await tx<{ id: string }[]>`select id from stores where key = ${input.store}`;
    if (!store) throw new PurchaseError(`Store ${input.store} is not set up`, 404);
    let lines = input.lines ?? [];
    if (input.quotationId) {
      const [quotation] = await tx<{ vendor_id: string }[]>`select vendor_id from quotations where id = ${input.quotationId}`;
      if (!quotation) throw new PurchaseError(`Quotation ${input.quotationId} not found`, 404);
      if (quotation.vendor_id !== input.vendorId) throw new PurchaseError('The quotation is from another vendor');
      if (lines.length === 0) {
        const quoted = await tx<{ variant_id: string; qty: number; price: string; request_id: string | null }[]>`
          select variant_id, qty, unit_price_paisa::text as price, purchase_request_id as request_id from quotation_lines where quotation_id = ${input.quotationId} order by id
        `;
        lines = quoted.map((q) => ({ variantId: q.variant_id, qty: q.qty, unitCost: readPaisa(q.price), requestId: q.request_id }));
      }
    }
    if (lines.length === 0) throw new PurchaseError('An order needs at least one line');
    const variants = await tx<{ id: string; store_id: string }[]>`select id, store_id from variants where id = any(${lines.map((l) => l.variantId)}::bigint[])`;
    for (const line of lines) {
      const variant = variants.find((v) => v.id === line.variantId);
      if (!variant) throw new PurchaseError(`Product ${line.variantId} not found`, 404);
      if (variant.store_id !== store.id) throw new PurchaseError(`Product ${line.variantId} is another brand's: one order per brand`);
    }
    const [po] = await tx<{ id: string; number: string }[]>`
      insert into purchase_orders (vendor_id, store_id, quotation_id, ordered_on, expected_on, note, created_by)
      values (${input.vendorId}, ${store.id}, ${input.quotationId ?? null}, ${input.orderedOn}, ${input.expectedOn ?? null}, ${input.note ?? null}, ${input.actorId})
      returning id, number
    `;
    for (const line of lines) {
      await tx`
        insert into po_lines (po_id, variant_id, purchase_request_id, qty, unit_cost_paisa)
        values (${po!.id}, ${line.variantId}, ${line.requestId ?? null}, ${line.qty}, ${big(line.unitCost)})
      `;
    }
    await audit(tx, input.actorId, 'purchase_order.create', 'purchase_orders', po!.id, {
      number: po!.number,
      vendorId: input.vendorId,
      store: input.store,
      total: sum(lines.map((l) => paisa(BigInt(l.qty) * l.unitCost))).toString(),
    });
    return po!;
  });

export const cancelPurchaseOrder = async (db: Db, id: string, actorId: string): Promise<void> =>
  atomically(db, async (tx) => {
    const [po] = await tx<{ cancelled_at: Date | null; received: boolean }[]>`
      select cancelled_at, exists (select 1 from goods_receipts r where r.po_id = po.id) as received from purchase_orders po where id = ${id} for update
    `;
    if (!po) throw new PurchaseError(`Purchase order ${id} not found`, 404);
    if (po.cancelled_at) throw new PurchaseError('The order is already cancelled');
    if (po.received) throw new PurchaseError('Goods have been received on this order; it cannot be cancelled');
    await tx`update purchase_orders set cancelled_at = now(), cancelled_by = ${actorId} where id = ${id}`;
    await audit(tx, actorId, 'purchase_order.cancel', 'purchase_orders', id, {});
  });

export type OrderStatus = 'cancelled' | 'ordered' | 'partially_received' | 'received' | 'billed' | 'paid';

/** Where an order has got to, from its documents: never stored (rule 7). */
export const orderStatus = (o: { cancelled: boolean; ordered: number; received: number; billed: number; billTotal: Paisa; paid: Paisa }): OrderStatus => {
  if (o.cancelled) return 'cancelled';
  if (o.received === 0) return 'ordered';
  if (o.received < o.ordered) return 'partially_received';
  if (o.billed < o.received) return 'received';
  return o.paid >= o.billTotal ? 'paid' : 'billed';
};

interface LineFacts {
  id: string;
  variant_id: string;
  sku: string | null;
  title: string;
  qty: number;
  unit_cost: string;
  received: number;
  billed_qty: number;
  billed_value: string;
}

const lineFacts = (db: Db, poId: string) =>
  db<LineFacts[]>`
    select pl.id, pl.variant_id, v.sku, p.title || ' · ' || v.title as title, pl.qty, pl.unit_cost_paisa::text as unit_cost,
           coalesce((select sum(g.qty) from gr_lines g where g.po_line_id = pl.id), 0)::int as received,
           coalesce((select sum(b.qty) from bill_lines b where b.po_line_id = pl.id), 0)::int as billed_qty,
           coalesce((select sum(b.qty * b.unit_price_paisa) from bill_lines b where b.po_line_id = pl.id), 0)::text as billed_value
    from po_lines pl join variants v on v.id = pl.variant_id join products p on p.id = v.product_id
    where pl.po_id = ${poId}
    order by pl.id
  `;

export interface PurchaseOrderSummary {
  id: string;
  number: string;
  vendorId: string;
  vendor: string;
  store: string;
  orderedOn: string;
  expectedOn: string | null;
  status: OrderStatus;
  ordered: number;
  received: number;
  billed: number;
  /** Order value at the agreed prices (paisa). */
  total: Paisa;
  billTotal: Paisa;
  paid: Paisa;
}

export const listPurchaseOrders = async (db: Db, opts: { vendorId?: string; open?: boolean } = {}): Promise<PurchaseOrderSummary[]> => {
  const rows = await db<{
    id: string; number: string; vendor_id: string; vendor: string; store: string; ordered_on: string; expected_on: string | null; cancelled: boolean;
    ordered: number; received: number; billed: number; total: string; bill_total: string; paid: string;
  }[]>`
    select po.id, po.number, po.vendor_id, v.name as vendor, st.key as store, po.ordered_on::text, po.expected_on::text, po.cancelled_at is not null as cancelled,
           (select coalesce(sum(qty), 0)::int from po_lines where po_id = po.id) as ordered,
           (select coalesce(sum(g.qty), 0)::int from gr_lines g join po_lines pl on pl.id = g.po_line_id where pl.po_id = po.id) as received,
           (select coalesce(sum(b.qty), 0)::int from bill_lines b join po_lines pl on pl.id = b.po_line_id where pl.po_id = po.id) as billed,
           (select coalesce(sum(qty * unit_cost_paisa), 0)::text from po_lines where po_id = po.id) as total,
           (select coalesce(sum(vb.tax_paisa + (select coalesce(sum(qty * unit_price_paisa), 0) from bill_lines where bill_id = vb.id)), 0)::text
            from vendor_bills vb where vb.po_id = po.id) as bill_total,
           (select coalesce(sum(vp.amount_paisa), 0)::text from vendor_payments vp join vendor_bills vb on vb.id = vp.bill_id where vb.po_id = po.id) as paid
    from purchase_orders po join vendors v on v.id = po.vendor_id join stores st on st.id = po.store_id
    ${opts.vendorId ? db`where po.vendor_id = ${opts.vendorId}` : db``}
    order by po.ordered_on desc, po.id desc
  `;
  return rows
    .map((r) => {
      const facts = { cancelled: r.cancelled, ordered: r.ordered, received: r.received, billed: r.billed, billTotal: readPaisa(r.bill_total), paid: readPaisa(r.paid) };
      return {
        id: r.id,
        number: r.number,
        vendorId: r.vendor_id,
        vendor: r.vendor,
        store: r.store,
        orderedOn: r.ordered_on,
        expectedOn: r.expected_on,
        status: orderStatus(facts),
        ordered: r.ordered,
        received: r.received,
        billed: r.billed,
        total: readPaisa(r.total),
        billTotal: facts.billTotal,
        paid: facts.paid,
      };
    })
    .filter((o) => !opts.open || !['cancelled', 'paid'].includes(o.status));
};

export interface PurchaseOrderDetail extends PurchaseOrderSummary {
  note: string | null;
  lines: Array<{ id: string; variantId: string; sku: string | null; title: string; qty: number; unitCost: Paisa; received: number; billed: number }>;
  receipts: Array<{ id: string; receivedAt: Date; receivedBy: string; lines: Array<{ poLineId: string; qty: number; costWritten: Paisa | null }> }>;
  bills: Array<{ id: string; billNumber: string; billDate: string; dueOn: string | null; total: Paisa; paid: Paisa; matches: boolean; mismatches: string[] }>;
}

/** A bill's lines as the match sees them, with every other bill on the same order lines. */
const billMatchLines = async (db: Db, billId: string): Promise<MatchLine[]> => {
  const rows = await db<{ po_line_id: string; title: string; unit_cost: string; received: number; billed_qty: number; billed_value: string; qty: number; value: string }[]>`
    select b.po_line_id, p.title || ' · ' || v.title as title, pl.unit_cost_paisa::text as unit_cost,
           coalesce((select sum(g.qty) from gr_lines g where g.po_line_id = pl.id), 0)::int as received,
           coalesce((select sum(o.qty) from bill_lines o where o.po_line_id = pl.id and o.bill_id <> ${billId}), 0)::int as billed_qty,
           coalesce((select sum(o.qty * o.unit_price_paisa) from bill_lines o where o.po_line_id = pl.id and o.bill_id <> ${billId}), 0)::text as billed_value,
           sum(b.qty)::int as qty, sum(b.qty * b.unit_price_paisa)::text as value
    from bill_lines b join po_lines pl on pl.id = b.po_line_id join variants v on v.id = pl.variant_id join products p on p.id = v.product_id
    where b.bill_id = ${billId}
    group by b.po_line_id, pl.id, p.title, v.title, pl.unit_cost_paisa
    order by b.po_line_id
  `;
  return rows.map((r) => ({
    poLineId: r.po_line_id,
    title: r.title,
    unitCost: readPaisa(r.unit_cost),
    received: r.received,
    billedQty: r.billed_qty,
    billedValue: readPaisa(r.billed_value),
    qty: r.qty,
    value: readPaisa(r.value),
  }));
};

export const purchaseOrderDetail = async (db: Db, id: string): Promise<PurchaseOrderDetail | null> => {
  const summary = (await listPurchaseOrders(db)).find((o) => o.id === id);
  if (!summary) return null;
  const [po] = await db<{ note: string | null }[]>`select note from purchase_orders where id = ${id}`;
  const lines = await lineFacts(db, id);
  const receipts = await db<{ id: string; received_at: Date; received_by: string }[]>`
    select r.id, r.received_at, u.name as received_by from goods_receipts r join users u on u.id = r.received_by where r.po_id = ${id} order by r.received_at, r.id
  `;
  const grLines = await db<{ receipt_id: string; po_line_id: string; qty: number; cost: string | null }[]>`
    select g.receipt_id, g.po_line_id, g.qty, pc.unit_cost_paisa::text as cost
    from gr_lines g join goods_receipts r on r.id = g.receipt_id left join product_costs pc on pc.id = g.product_cost_id
    where r.po_id = ${id} order by g.id
  `;
  const bills = await db<{ id: string; bill_number: string; bill_date: string; due_on: string | null; total: string; paid: string }[]>`
    select vb.id, vb.bill_number, vb.bill_date::text, vb.due_on::text,
           (vb.tax_paisa + (select coalesce(sum(qty * unit_price_paisa), 0) from bill_lines where bill_id = vb.id))::text as total,
           (select coalesce(sum(amount_paisa), 0) from vendor_payments where bill_id = vb.id)::text as paid
    from vendor_bills vb where vb.po_id = ${id} order by vb.bill_date, vb.id
  `;
  const settings = await purchasingSettings(db);
  return {
    ...summary,
    note: po?.note ?? null,
    lines: lines.map((l) => ({ id: l.id, variantId: l.variant_id, sku: l.sku, title: l.title, qty: l.qty, unitCost: readPaisa(l.unit_cost), received: l.received, billed: l.billed_qty })),
    receipts: receipts.map((r) => ({
      id: r.id,
      receivedAt: r.received_at,
      receivedBy: r.received_by,
      lines: grLines.filter((g) => g.receipt_id === r.id).map((g) => ({ poLineId: g.po_line_id, qty: g.qty, costWritten: g.cost === null ? null : readPaisa(g.cost) })),
    })),
    bills: await Promise.all(
      bills.map(async (b) => {
        const mismatches = threeWayMatch(await billMatchLines(db, b.id), settings);
        return { id: b.id, billNumber: b.bill_number, billDate: b.bill_date, dueOn: b.due_on, total: readPaisa(b.total), paid: readPaisa(b.paid), matches: mismatches.length === 0, mismatches };
      }),
    ),
  };
};

// ---- Step 4: goods receipt ----

const OWNED_KINDS = ['warehouse', 'partner', 'in_transit', 'returning'];

export interface ReceiptInput {
  poId: string;
  receivedAt: Date;
  lines: Array<{ poLineId: string; qty: number }>;
  note?: string | null;
  actorId: string;
}

export interface ReceiptResult {
  receiptId: string;
  lines: Array<{ poLineId: string; variantId: string; qty: number; cost: Paisa }>;
  value: Paisa;
}

/**
 * Receives goods against an order, all or part of what is outstanding. Per line: a
 * `supplier → warehouse` move and the product's new cost; for the receipt: its value into
 * Inventory, owed to the vendor until the bill comes.
 */
export const receiveGoods = async (db: Db, input: ReceiptInput): Promise<ReceiptResult> =>
  atomically(db, async (tx) => {
    const [po] = await tx<{ vendor_id: string; store_id: string; number: string; cancelled_at: Date | null }[]>`
      select vendor_id, store_id, number, cancelled_at from purchase_orders where id = ${input.poId} for update
    `;
    if (!po) throw new PurchaseError(`Purchase order ${input.poId} not found`, 404);
    if (po.cancelled_at) throw new PurchaseError(`${po.number} is cancelled`);
    if (input.receivedAt.getTime() > Date.now() + 60_000) throw new PurchaseError('Goods cannot be received in the future');
    if (input.lines.length === 0) throw new PurchaseError('A receipt needs at least one line');
    if (new Set(input.lines.map((l) => l.poLineId)).size !== input.lines.length) throw new PurchaseError('Each order line once per receipt');
    const facts = await lineFacts(tx, input.poId);
    for (const line of input.lines) {
      const f = facts.find((x) => x.id === line.poLineId);
      if (!f) throw new PurchaseError(`Line ${line.poLineId} is not on ${po.number}`, 404);
      const outstanding = f.qty - f.received;
      if (line.qty > outstanding) {
        throw new PurchaseError(`${f.title}: receiving ${line.qty}, but only ${outstanding} of ${f.qty} ordered are still to come`);
      }
    }

    const [receipt] = await tx<{ id: string }[]>`
      insert into goods_receipts (po_id, received_at, received_by, note) values (${input.poId}, ${input.receivedAt}, ${input.actorId}, ${input.note ?? null})
      returning id
    `;
    const supplier = await locationId(tx, 'supplier');
    const warehouse = await locationId(tx, 'warehouse');
    const day = karachiDay(input.receivedAt);
    const result: ReceiptResult['lines'] = [];
    for (const line of input.lines) {
      const f = facts.find((x) => x.id === line.poLineId)!;
      const price = readPaisa(f.unit_cost);
      // What the brand holds before these units arrive, and what it is costed at now.
      const [held] = await tx<{ units: number }[]>`
        select coalesce(sum(q.qty), 0)::int as units from stock_quants q join locations l on l.id = q.location_id
        where q.variant_id = ${f.variant_id} and l.kind = any(${OWNED_KINDS}::text[])
      `;
      const cost = movingAverageCost(held!.units, await costAt(tx, f.variant_id, input.receivedAt), line.qty, price);
      const [costRow] = await tx<{ id: string }[]>`
        insert into product_costs (variant_id, unit_cost_paisa, effective_from, source, note, actor_id)
        values (${f.variant_id}, ${big(cost)}, ${day}, 'goods_receipt', ${`${po.number}: ${line.qty} at ${formatRupees(price)}, ${held!.units} held`}, ${input.actorId})
        returning id
      `;
      const [grLine] = await tx<{ id: string }[]>`
        insert into gr_lines (receipt_id, po_line_id, qty, product_cost_id) values (${receipt!.id}, ${line.poLineId}, ${line.qty}, ${costRow!.id}) returning id
      `;
      await recordMove(tx, {
        variantId: f.variant_id,
        qty: line.qty,
        from: supplier,
        to: warehouse,
        reason: 'goods_receipt',
        refType: 'gr_line',
        refId: grLine!.id,
        actorId: input.actorId,
        occurredAt: input.receivedAt,
        note: po.number,
      });
      await costRecorded(tx, f.variant_id, day, `Cost from ${po.number}`);
      result.push({ poLineId: line.poLineId, variantId: f.variant_id, qty: line.qty, cost });
    }
    const value = sum(input.lines.map((l) => paisa(BigInt(l.qty) * readPaisa(facts.find((x) => x.id === l.poLineId)!.unit_cost))));
    await postEntry(tx, {
      date: day,
      memo: `Goods received on ${po.number}`,
      source: { type: 'goods_receipt', id: receipt!.id },
      lines: goodsReceiptLines({ vendorId: po.vendor_id, storeId: po.store_id, value }),
      postedBy: input.actorId,
    }).catch(asPeriod);
    await audit(tx, input.actorId, 'goods_receipt.create', 'purchase_orders', input.poId, {
      receiptId: receipt!.id,
      value: value.toString(),
      lines: result.map((r) => ({ poLineId: r.poLineId, qty: r.qty, cost: r.cost.toString() })),
    });
    return { receiptId: receipt!.id, lines: result, value };
  });

// ---- Step 5: bill and payment ----

export interface BillInput {
  poId: string;
  billNumber: string;
  billDate: string;
  dueOn?: string | null;
  tax: Paisa;
  lines: Array<{ poLineId: string; qty: number; unitPrice: Paisa }>;
  /** Lines with no product: freight, packing. */
  charges?: Array<{ description: string; amount: Paisa }>;
  actorId: string;
}

/** Records a vendor's bill against an order, if it passes the three-way match, and posts it. */
export const recordBill = async (db: Db, input: BillInput): Promise<{ billId: string; total: Paisa }> =>
  atomically(db, async (tx) => {
    const [po] = await tx<{ vendor_id: string; store_id: string; number: string; cancelled_at: Date | null; payment_terms_days: number | null }[]>`
      select po.vendor_id, po.store_id, po.number, po.cancelled_at, v.payment_terms_days
      from purchase_orders po join vendors v on v.id = po.vendor_id where po.id = ${input.poId} for update of po
    `;
    if (!po) throw new PurchaseError(`Purchase order ${input.poId} not found`, 404);
    if (po.cancelled_at) throw new PurchaseError(`${po.number} is cancelled`);
    if (input.lines.length === 0 && (input.charges ?? []).length === 0) throw new PurchaseError('A bill needs at least one line');
    const [duplicate] = await tx`select 1 from vendor_bills where vendor_id = ${po.vendor_id} and lower(trim(bill_number)) = lower(trim(${input.billNumber}))`;
    if (duplicate) throw new PurchaseError(`Bill ${input.billNumber} from this vendor is already recorded`);
    const facts = await lineFacts(tx, input.poId);
    const byLine = new Map<string, { qty: number; value: Paisa }>();
    for (const line of input.lines) {
      if (!facts.some((f) => f.id === line.poLineId)) throw new PurchaseError(`Line ${line.poLineId} is not on ${po.number}`, 404);
      const prev = byLine.get(line.poLineId) ?? { qty: 0, value: ZERO };
      byLine.set(line.poLineId, { qty: prev.qty + line.qty, value: add(prev.value, paisa(BigInt(line.qty) * line.unitPrice)) });
    }
    const match: MatchLine[] = [...byLine].map(([poLineId, billing]) => {
      const f = facts.find((x) => x.id === poLineId)!;
      return {
        poLineId,
        title: f.title,
        unitCost: readPaisa(f.unit_cost),
        received: f.received,
        billedQty: f.billed_qty,
        billedValue: readPaisa(f.billed_value),
        qty: billing.qty,
        value: billing.value,
      };
    });
    const mismatches = threeWayMatch(match, await purchasingSettings(tx));
    if (mismatches.length > 0) throw new PurchaseError(`The bill does not match ${po.number}: ${mismatches.join('; ')}`);

    const due = input.dueOn ?? (po.payment_terms_days === null ? null : addDays(input.billDate, po.payment_terms_days));
    const [bill] = await tx<{ id: string }[]>`
      insert into vendor_bills (vendor_id, po_id, bill_number, bill_date, due_on, tax_paisa, created_by)
      values (${po.vendor_id}, ${input.poId}, ${input.billNumber}, ${input.billDate}, ${due}, ${big(input.tax)}, ${input.actorId})
      returning id
    `.catch(asConflict(`Bill ${input.billNumber} from this vendor is already recorded`));
    for (const line of input.lines) {
      await tx`
        insert into bill_lines (bill_id, po_line_id, qty, unit_price_paisa) values (${bill!.id}, ${line.poLineId}, ${line.qty}, ${big(line.unitPrice)})
      `;
    }
    for (const charge of input.charges ?? []) {
      await tx`
        insert into bill_lines (bill_id, description, qty, unit_price_paisa) values (${bill!.id}, ${charge.description}, 1, ${big(charge.amount)})
      `;
    }
    const goods = sum([...byLine.values()].map((b) => b.value));
    const received = sum(match.map((m) => paisa(BigInt(m.qty) * m.unitCost)));
    const charges = sum((input.charges ?? []).map((c) => c.amount));
    const total = add(add(goods, charges), input.tax);
    await postEntry(tx, {
      date: input.billDate,
      memo: `Bill ${input.billNumber} on ${po.number}`,
      source: { type: 'vendor_bill', id: bill!.id },
      lines: purchaseBillLines({ vendorId: po.vendor_id, storeId: po.store_id, received, variance: sub(goods, received), charges, tax: input.tax }),
      postedBy: input.actorId,
    }).catch(asPeriod);
    await audit(tx, input.actorId, 'vendor_bill.create', 'vendor_bills', bill!.id, {
      po: po.number,
      billNumber: input.billNumber,
      total: total.toString(),
      variance: sub(goods, received).toString(),
    });
    return { billId: bill!.id, total };
  });

const addDays = (day: string, days: number): string => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

export interface PaymentInput {
  billId: string;
  amount: Paisa;
  paidOn: string;
  method: 'bank_transfer' | 'cash' | 'cheque';
  reference?: string | null;
  actorId: string;
}

/** Pays all or part of a bill, if it still matches its order and receipts. */
export const payBill = async (db: Db, input: PaymentInput): Promise<{ paymentId: string; outstanding: Paisa }> =>
  atomically(db, async (tx) => {
    const [bill] = await tx<{ vendor_id: string; store_id: string; bill_number: string; number: string; total: string; paid: string }[]>`
      select vb.vendor_id, po.store_id, vb.bill_number, po.number,
             (vb.tax_paisa + (select coalesce(sum(qty * unit_price_paisa), 0) from bill_lines where bill_id = vb.id))::text as total,
             (select coalesce(sum(amount_paisa), 0) from vendor_payments where bill_id = vb.id)::text as paid
      from vendor_bills vb join purchase_orders po on po.id = vb.po_id where vb.id = ${input.billId}
      for update of vb
    `;
    if (!bill) throw new PurchaseError(`Bill ${input.billId} not found`, 404);
    const mismatches = threeWayMatch(await billMatchLines(tx, input.billId), await purchasingSettings(tx));
    if (mismatches.length > 0) throw new PurchaseError(`Payment blocked: bill ${bill.bill_number} no longer matches ${bill.number}: ${mismatches.join('; ')}`);
    const outstanding = sub(readPaisa(bill.total), readPaisa(bill.paid));
    if (input.amount > outstanding) throw new PurchaseError(`Bill ${bill.bill_number} has ${formatRupees(outstanding)} outstanding; ${formatRupees(input.amount)} is more`);
    const [payment] = await tx<{ id: string }[]>`
      insert into vendor_payments (vendor_id, bill_id, amount_paisa, paid_on, method, reference, created_by)
      values (${bill.vendor_id}, ${input.billId}, ${big(input.amount)}, ${input.paidOn}, ${input.method}, ${input.reference ?? null}, ${input.actorId})
      returning id
    `;
    await postEntry(tx, {
      date: input.paidOn,
      memo: `Payment of bill ${bill.bill_number} (${bill.number})`,
      source: { type: 'vendor_payment', id: payment!.id },
      lines: vendorPaymentLines({ vendorId: bill.vendor_id, amount: input.amount, storeId: bill.store_id }),
      postedBy: input.actorId,
    }).catch(asPeriod);
    await audit(tx, input.actorId, 'vendor_payment.create', 'vendor_bills', input.billId, { paymentId: payment!.id, amount: input.amount.toString(), method: input.method });
    return { paymentId: payment!.id, outstanding: sub(outstanding, input.amount) };
  });

export interface BillRow {
  id: string;
  vendorId: string;
  vendor: string;
  poId: string;
  poNumber: string;
  billNumber: string;
  billDate: string;
  dueOn: string | null;
  total: Paisa;
  paid: Paisa;
  outstanding: Paisa;
  overdue: boolean;
}

/** Bills, unpaid ones first by due date. */
export const listBills = async (db: Db, opts: { unpaidOnly?: boolean; today: string }): Promise<BillRow[]> => {
  const rows = await db<{ id: string; vendor_id: string; vendor: string; po_id: string; po_number: string; bill_number: string; bill_date: string; due_on: string | null; total: string; paid: string }[]>`
    select vb.id, vb.vendor_id, v.name as vendor, po.id as po_id, po.number as po_number, vb.bill_number, vb.bill_date::text, vb.due_on::text,
           (vb.tax_paisa + (select coalesce(sum(qty * unit_price_paisa), 0) from bill_lines where bill_id = vb.id))::text as total,
           (select coalesce(sum(amount_paisa), 0) from vendor_payments where bill_id = vb.id)::text as paid
    from vendor_bills vb join vendors v on v.id = vb.vendor_id join purchase_orders po on po.id = vb.po_id
    order by vb.due_on nulls last, vb.bill_date, vb.id
  `;
  return rows
    .map((r) => {
      const total = readPaisa(r.total);
      const paid = readPaisa(r.paid);
      const outstanding = sub(total, paid);
      return {
        id: r.id,
        vendorId: r.vendor_id,
        vendor: r.vendor,
        poId: r.po_id,
        poNumber: r.po_number,
        billNumber: r.bill_number,
        billDate: r.bill_date,
        dueOn: r.due_on,
        total,
        paid,
        outstanding,
        overdue: outstanding > 0n && r.due_on !== null && r.due_on < opts.today,
      };
    })
    .filter((b) => !opts.unpaidOnly || b.outstanding > 0n);
};

// ---- Reorder suggestions ----

export interface ReorderSuggestion {
  variantId: string;
  store: string;
  sku: string | null;
  title: string;
  /** Units delivered to customers in the window, net of returns after delivery. */
  delivered: number;
  windowDays: number;
  /** Units a day, for display; the quantity is computed on whole units. */
  dailyVelocity: number;
  warehouse: number;
  onOrder: number;
  openRequests: number;
  /** How long the shelf lasts at the delivered rate; null with no deliveries. */
  daysOfCover: number | null;
  leadTimeDays: number;
  suggestedQty: number;
  lastVendor: { id: string; name: string; unitCost: Paisa } | null;
}

/**
 * Reorder suggestions from **delivered** velocity (Step 12): units that reached customers in the
 * window (moved to `customer`, less any that came back from there), never placed orders. An
 * order placed, booked or in transit has not sold yet, and a third of them may come back
 * (11.8% returned on the measured data, more refused at the door), so counting them would order
 * stock for sales that never happen.
 */
export const reorderSuggestions = async (
  db: Db,
  opts: { now: Date; store?: 'nur' | 'organics'; windowDays?: number; coverDays?: number },
): Promise<ReorderSuggestion[]> => {
  const settings = await purchasingSettings(db);
  const windowDays = opts.windowDays ?? settings.velocityWindowDays;
  const coverDays = opts.coverDays ?? settings.coverDays;
  // Whole Karachi days back from today, today included.
  const today = formatKarachi(opts.now).slice(0, 10);
  const since = startOfKarachiDate(addDays(today, 1 - windowDays));
  const until = endOfKarachiDay(today);
  const rows = await db<{
    variant_id: string; store: string; sku: string | null; title: string; delivered: number; warehouse: number; on_order: number; requests: number;
    vendor_id: string | null; vendor: string | null; unit_cost: string | null; lead_time_days: number | null;
  }[]>`
    with delivered as (
      select m.variant_id,
             sum(case when lt.key = 'customer' then m.qty else -m.qty end)::int as units
      from stock_moves m
      join locations lf on lf.id = m.from_location_id
      join locations lt on lt.id = m.to_location_id
      where (lt.key = 'customer' or lf.key = 'customer') and m.occurred_at between ${since} and ${until}
      group by m.variant_id
    ),
    on_order as (
      select pl.variant_id, sum(pl.qty - coalesce((select sum(g.qty) from gr_lines g where g.po_line_id = pl.id), 0))::int as units
      from po_lines pl join purchase_orders po on po.id = pl.po_id
      where po.cancelled_at is null
      group by pl.variant_id
    ),
    requests as (
      select r.variant_id, sum(r.qty)::int as units from purchase_requests r
      where r.cancelled_at is null
        and not exists (select 1 from po_lines pl join purchase_orders po on po.id = pl.po_id where pl.purchase_request_id = r.id and po.cancelled_at is null)
      group by r.variant_id
    ),
    last_purchase as (
      select distinct on (pl.variant_id) pl.variant_id, po.vendor_id, v.name as vendor, pl.unit_cost_paisa, v.lead_time_days
      from po_lines pl join purchase_orders po on po.id = pl.po_id join vendors v on v.id = po.vendor_id
      where po.cancelled_at is null
      order by pl.variant_id, po.ordered_on desc, pl.id desc
    )
    select va.id as variant_id, st.key as store, va.sku, p.title || ' · ' || va.title as title,
           coalesce(d.units, 0) as delivered,
           coalesce((select q.qty from stock_quants q join locations l on l.id = q.location_id where q.variant_id = va.id and l.key = 'warehouse'), 0)::int as warehouse,
           coalesce(oo.units, 0) as on_order, coalesce(rq.units, 0) as requests,
           lp.vendor_id, lp.vendor, lp.unit_cost_paisa::text as unit_cost, lp.lead_time_days
    from variants va
    join products p on p.id = va.product_id
    join stores st on st.id = va.store_id
    left join delivered d on d.variant_id = va.id
    left join on_order oo on oo.variant_id = va.id
    left join requests rq on rq.variant_id = va.id
    left join last_purchase lp on lp.variant_id = va.id
    where va.deleted_at is null and (coalesce(d.units, 0) > 0 or coalesce(oo.units, 0) > 0 or coalesce(rq.units, 0) > 0)
      ${opts.store ? db`and st.key = ${opts.store}` : db``}
  `;
  return rows
    .map((r) => {
      const leadTimeDays = r.lead_time_days ?? settings.defaultLeadTimeDays;
      return {
        variantId: r.variant_id,
        store: r.store,
        sku: r.sku,
        title: r.title,
        delivered: r.delivered,
        windowDays,
        dailyVelocity: r.delivered / windowDays,
        warehouse: r.warehouse,
        onOrder: r.on_order,
        openRequests: r.requests,
        daysOfCover: r.delivered > 0 ? Math.floor((Math.max(0, r.warehouse) * windowDays) / r.delivered) : null,
        leadTimeDays,
        suggestedQty: reorderQty({ variantId: r.variant_id, delivered: r.delivered, windowDays, warehouse: r.warehouse, onOrder: r.on_order, leadTimeDays, coverDays }),
        lastVendor: r.vendor_id ? { id: r.vendor_id, name: r.vendor!, unitCost: readPaisa(r.unit_cost!) } : null,
      };
    })
    .sort((a, b) => b.suggestedQty - a.suggestedQty || (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) || a.title.localeCompare(b.title));
};
