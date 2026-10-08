import { createHash } from 'node:crypto';

import { type Db, atomically, big, readPaisa } from '../db/repos/upsert.js';
import { costAt } from '../db/repos/variants.js';
import { parseCsv } from '../lib/csv.js';
import { type Paisa, ZERO, add, fromRupeeString, paisa, sum } from '../lib/money.js';
import { endOfKarachiDay, formatKarachi } from '../lib/time.js';
import { karachiDay, postConsignmentSale, reverseEntry } from './accounting.js';
import { locationId, recordMove } from './stock.js';

/**
 * Consignment (Step 12): stock at a retail partner stays ours until it sells.
 *
 * - A **transfer** moves units `warehouse → partner` (out) or `partner → warehouse` (back).
 * - The partner's **sales sheet** is imported in two phases. The dry run validates every row and
 *   writes nothing. The commit validates again, inside the transaction, and then per sold line:
 *   a `partner → customer` move, a `partner_sales` row; per brand: an invoice; per brand and
 *   sale day: the sale (Partner receivable / revenue, tax) and its cost (COGS / Inventory) at the
 *   product's cost on the sale day.
 * - A sheet is identified by its SHA-256. The same file again is refused unless it is imported
 *   explicitly as a new version; a reversed import's file can be imported again.
 * - An import is **reversed as a unit**: every unit back `customer → partner`, every entry
 *   reversed, the invoices voided. Audited, with the reason.
 */

export class ConsignmentError extends Error {
  readonly status: 404 | 409;
  /** The per-row report, when the error is about the file's rows. */
  readonly report?: SheetReport;
  constructor(message: string, status: 404 | 409 = 409, report?: SheetReport) {
    super(message);
    this.name = 'ConsignmentError';
    this.status = status;
    if (report) this.report = report;
  }
}

/** The published template: these columns, in any order, header names case-insensitive. */
export const TEMPLATE_COLUMNS = ['date', 'sku', 'quantity', 'unit_price', 'tax'] as const;
export const TEMPLATE_CSV =
  'date,sku,quantity,unit_price,tax\n' +
  '2026-09-01,NBJ-SERUM-30,3,1450.00,0\n' +
  '2026-09-02,NBJ-CREAM-50,1,990,0\n';
/** Optional columns; the rest are required. */
const OPTIONAL = new Set(['tax']);

const audit = (db: Db, actorId: string, action: string, entity: string, entityId: string, after: Record<string, unknown>) =>
  db`insert into audit_log (actor_id, action, entity, entity_id, after) values (${actorId}, ${action}, ${entity}, ${entityId}, ${db.json(after as never)})`;

const partnerLocation = async (db: Db, partnerId: string): Promise<{ id: string; name: string }> => {
  const [row] = await db<{ id: string; name: string }[]>`
    select l.id, p.name from locations l join retail_partners p on p.id = l.partner_id where l.partner_id = ${partnerId}
  `;
  if (!row) throw new ConsignmentError(`Partner ${partnerId} not found`, 404);
  return row;
};

const quantAt = async (db: Db, variantId: string, location: string): Promise<number> =>
  (await db<{ qty: number }[]>`select coalesce(sum(qty), 0)::int as qty from stock_quants where variant_id = ${variantId} and location_id = ${location}`)[0]!.qty;

// ---- Partners ----

export interface PartnerInput {
  name: string;
  contact?: string | null;
  phone?: string | null;
  city?: string | null;
  terms?: string | null;
}

/** A partner and the stock location that is theirs. */
export const createPartner = async (db: Db, input: PartnerInput, actorId: string): Promise<string> =>
  atomically(db, async (tx) => {
    const [partner] = await tx<{ id: string }[]>`
      insert into retail_partners (name, contact, phone, city, terms)
      values (${input.name}, ${input.contact ?? null}, ${input.phone ?? null}, ${input.city ?? null}, ${input.terms ?? null})
      returning id
    `;
    await tx`insert into locations (kind, label, partner_id) values ('partner', ${`Partner: ${input.name}`}, ${partner!.id})`;
    await audit(tx, actorId, 'partner.create', 'retail_partners', partner!.id, { ...input });
    return partner!.id;
  });

export interface PartnerRow {
  id: string;
  name: string;
  city: string | null;
  contact: string | null;
  phone: string | null;
  terms: string | null;
  isActive: boolean;
  /** Units of ours at the partner now. */
  units: number;
  /** What the partner owes, from Partner receivable (paisa). */
  receivable: Paisa;
}

export const listPartners = async (db: Db): Promise<PartnerRow[]> => {
  const rows = await db<{ id: string; name: string; city: string | null; contact: string | null; phone: string | null; terms: string | null; is_active: boolean; units: number; receivable: string }[]>`
    select p.id, p.name, p.city, p.contact, p.phone, p.terms, p.is_active,
           coalesce((select sum(q.qty) from stock_quants q join locations l on l.id = q.location_id where l.partner_id = p.id), 0)::int as units,
           coalesce((select sum(jl.debit_paisa - jl.credit_paisa) from journal_lines jl join accounts a on a.id = jl.account_id
                     where a.code = '1200' and jl.partner_type = 'retail_partner' and jl.partner_id = p.id), 0)::text as receivable
    from retail_partners p order by p.is_active desc, lower(p.name)
  `;
  return rows.map((r) => ({ id: r.id, name: r.name, city: r.city, contact: r.contact, phone: r.phone, terms: r.terms, isActive: r.is_active, units: r.units, receivable: readPaisa(r.receivable) }));
};

export const partnerStock = async (db: Db, partnerId: string): Promise<Array<{ variantId: string; store: string; sku: string | null; title: string; qty: number }>> => {
  const location = await partnerLocation(db, partnerId);
  const rows = await db<{ variant_id: string; store: string; sku: string | null; title: string; qty: number }[]>`
    select q.variant_id, st.key as store, v.sku, p.title || case when v.title = 'Default Title' then '' else ' · ' || v.title end as title, q.qty::int as qty
    from stock_quants q join variants v on v.id = q.variant_id join products p on p.id = v.product_id join stores st on st.id = v.store_id
    where q.location_id = ${location.id} and q.qty <> 0
    order by st.key, p.title, v.title
  `;
  return rows.map((r) => ({ variantId: r.variant_id, store: r.store, sku: r.sku, title: r.title, qty: r.qty }));
};

// ---- Transfers ----

export interface TransferInput {
  partnerId: string;
  direction: 'out' | 'back';
  sentAt: Date;
  lines: Array<{ variantId: string; qty: number }>;
  note?: string | null;
  actorId: string;
}

/**
 * Goods out to a partner, or back from one. Back is refused beyond what the partner holds; out
 * is not refused on the warehouse count, which can lag reality until the opening count is in
 * (negative stock is reported on its own).
 */
export const createTransfer = async (db: Db, input: TransferInput): Promise<string> =>
  atomically(db, async (tx) => {
    const partner = await partnerLocation(tx, input.partnerId);
    if (input.lines.length === 0) throw new ConsignmentError('A transfer needs at least one line');
    if (new Set(input.lines.map((l) => l.variantId)).size !== input.lines.length) throw new ConsignmentError('Each product once per transfer');
    const warehouse = await locationId(tx, 'warehouse');
    if (input.direction === 'back') {
      for (const line of input.lines) {
        const held = await quantAt(tx, line.variantId, partner.id);
        if (line.qty > held) throw new ConsignmentError(`${partner.name} holds ${held} of product ${line.variantId}; ${line.qty} cannot come back`);
      }
    }
    const [transfer] = await tx<{ id: string }[]>`
      insert into consignment_transfers (partner_id, direction, sent_at, note, created_by)
      values (${input.partnerId}, ${input.direction}, ${input.sentAt}, ${input.note ?? null}, ${input.actorId}) returning id
    `;
    for (const line of input.lines) {
      const [row] = await tx<{ id: string }[]>`
        insert into consignment_transfer_lines (transfer_id, variant_id, qty) values (${transfer!.id}, ${line.variantId}, ${line.qty}) returning id
      `.catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && (error as { code?: string }).code === '23503') throw new ConsignmentError(`Product ${line.variantId} not found`, 404);
        throw error;
      });
      const out = input.direction === 'out';
      await recordMove(tx, {
        variantId: line.variantId,
        qty: line.qty,
        from: out ? warehouse : partner.id,
        to: out ? partner.id : warehouse,
        reason: out ? 'consignment_out' : 'consignment_back',
        refType: 'consignment_transfer_line',
        refId: row!.id,
        actorId: input.actorId,
        occurredAt: input.sentAt,
      });
    }
    await audit(tx, input.actorId, `consignment.transfer_${input.direction}`, 'retail_partners', input.partnerId, { transferId: transfer!.id, lines: input.lines });
    return transfer!.id;
  });

// ---- Sales sheets ----

export interface ValidRow {
  row: number;
  saleDate: string;
  variantId: string;
  storeId: string;
  sku: string;
  qty: number;
  unitPrice: Paisa;
  tax: Paisa;
  unitCost: Paisa;
}

export interface RowReport {
  /** The line in the file, header being line 1: what a person sees in a spreadsheet. */
  row: number;
  ok: boolean;
  errors: string[];
}

export interface SheetReport {
  fileSha256: string;
  /** Problems with the file itself (unreadable, missing columns); no row is read then. */
  fileErrors: string[];
  rows: RowReport[];
  valid: number;
  invalid: number;
  /** Totals of the valid rows. */
  units: number;
  net: Paisa;
  tax: Paisa;
  cost: Paisa;
  /** Set when this exact file was already imported and not reversed. */
  alreadyImported: { importId: string; version: number; importedAt: Date } | null;
}

/** The file's identity: its content, line ends normalised so a re-save on another OS is the same file. */
export const sheetHash = (csv: string): string => createHash('sha256').update(csv.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimEnd()).digest('hex');

const isDay = (text: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  try {
    endOfKarachiDay(text);
    return true;
  } catch {
    return false;
  }
};

const rupees = (text: string, column: string, errors: string[], optional = false): Paisa | null => {
  if (text.trim() === '') {
    if (optional) return ZERO;
    errors.push(`${column} is empty`);
    return null;
  }
  try {
    const value = fromRupeeString(text.replace(/^(rs\.?|pkr)\s*/i, ''));
    if (value < 0n) {
      errors.push(`${column} "${text}" is negative`);
      return null;
    }
    return value;
  } catch {
    errors.push(`${column} "${text}" is not an amount in rupees`);
    return null;
  }
};

/**
 * Validates a sheet against the template, the catalogue, the partner's stock and the books, and
 * writes nothing. Every row gets every problem it has, not just the first.
 */
export const validateSheet = async (db: Db, partnerId: string, csv: string, now: Date): Promise<SheetReport & { validRows: ValidRow[] }> => {
  const partner = await partnerLocation(db, partnerId);
  const fileSha256 = sheetHash(csv);
  const empty = { fileSha256, rows: [], valid: 0, invalid: 0, units: 0, net: ZERO, tax: ZERO, cost: ZERO, validRows: [] };
  const [previous] = await db<{ id: string; version: number; imported_at: Date }[]>`
    select id, version, imported_at from partner_sales_imports
    where partner_id = ${partnerId} and file_sha256 = ${fileSha256} and reversed_at is null order by version desc limit 1
  `;
  const alreadyImported = previous ? { importId: previous.id, version: previous.version, importedAt: previous.imported_at } : null;

  let parsed;
  try {
    parsed = parseCsv(csv);
  } catch (error) {
    return { ...empty, fileErrors: [(error as Error).message], alreadyImported };
  }
  const [header, ...body] = parsed;
  const columns = (header?.cells ?? []).map((c) => c.trim().toLowerCase());
  const missing = TEMPLATE_COLUMNS.filter((c) => !OPTIONAL.has(c) && !columns.includes(c));
  if (!header || missing.length > 0) {
    return { ...empty, fileErrors: [`Missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || TEMPLATE_COLUMNS.join(', ')}. Use the template.`], alreadyImported };
  }
  const at = (cells: string[], column: string) => (columns.includes(column) ? (cells[columns.indexOf(column)] ?? '').trim() : '');

  const today = formatKarachi(now).slice(0, 10);
  const closed = new Set(
    (await db<{ m: string }[]>`select to_char(make_date(year, month, 1), 'YYYY-MM') as m from fiscal_periods where status = 'closed'`).map((r) => r.m),
  );
  // Stock left at the partner as the rows use it up, per product.
  const left = new Map<string, number>();
  const rows: RowReport[] = [];
  const validRows: ValidRow[] = [];
  for (const { line, cells } of body) {
    if (cells.every((c) => c.trim() === '')) continue;
    const errors: string[] = [];
    const date = at(cells, 'date');
    if (!isDay(date)) errors.push(`date "${date}" is not a date as YYYY-MM-DD`);
    else if (date > today) errors.push(`date ${date} is in the future`);
    else if (closed.has(date.slice(0, 7))) errors.push(`date ${date} is in ${date.slice(0, 7)}, which is closed`);

    const sku = at(cells, 'sku');
    let variant: { id: string; store_id: string } | undefined;
    if (!sku) errors.push('sku is empty');
    else {
      const found = await db<{ id: string; store_id: string }[]>`
        select id, store_id from variants where lower(trim(sku)) = lower(${sku}) and deleted_at is null
      `;
      if (found.length === 0) errors.push(`sku "${sku}" is not one of our products`);
      else if (found.length > 1) errors.push(`sku "${sku}" belongs to more than one product; give the partner distinct SKUs`);
      else variant = found[0];
    }

    const qtyText = at(cells, 'quantity');
    const qty = /^\d+$/.test(qtyText) ? Number(qtyText) : NaN;
    if (!Number.isSafeInteger(qty) || qty <= 0) errors.push(`quantity "${qtyText}" is not a whole number above zero`);

    const unitPrice = rupees(at(cells, 'unit_price'), 'unit_price', errors);
    const tax = rupees(at(cells, 'tax'), 'tax', errors, true);

    let unitCost: Paisa | null = null;
    if (variant && isDay(date)) {
      unitCost = await costAt(db, variant.id, endOfKarachiDay(date));
      if (unitCost === null) errors.push(`sku "${sku}" has no cost on ${date}; enter its cost first`);
    }
    if (variant && errors.length === 0) {
      const remaining = left.get(variant.id) ?? (await quantAt(db, variant.id, partner.id));
      if (qty > remaining) errors.push(`${partner.name} holds ${remaining} of "${sku}"${left.has(variant.id) ? ' after the rows above' : ''}; ${qty} cannot have sold`);
      else left.set(variant.id, remaining - qty);
    }

    rows.push({ row: line, ok: errors.length === 0, errors });
    if (errors.length === 0) {
      validRows.push({ row: line, saleDate: date, variantId: variant!.id, storeId: variant!.store_id, sku, qty, unitPrice: unitPrice!, tax: tax!, unitCost: unitCost! });
    }
  }
  const fileErrors = rows.length === 0 ? ['The file has no rows'] : [];
  return {
    fileSha256,
    fileErrors,
    rows,
    valid: validRows.length,
    invalid: rows.length - validRows.length,
    units: validRows.reduce((n, r) => n + r.qty, 0),
    net: sum(validRows.map((r) => paisa(BigInt(r.qty) * r.unitPrice))),
    tax: sum(validRows.map((r) => r.tax)),
    cost: sum(validRows.map((r) => paisa(BigInt(r.qty) * r.unitCost))),
    alreadyImported,
    validRows,
  };
};

const report = ({ validRows: _v, ...rest }: SheetReport & { validRows: ValidRow[] }): SheetReport => rest;

/** The dry run: the report the commit would act on. Reads only. */
export const dryRunImport = async (db: Db, partnerId: string, csv: string, now = new Date()): Promise<SheetReport> =>
  report(await validateSheet(db, partnerId, csv, now));

export interface CommitInput {
  partnerId: string;
  fileName: string;
  csv: string;
  /** Commit the valid rows and skip the invalid ones. */
  force?: boolean;
  /** Import a file already imported as a new version, on purpose. */
  newVersion?: boolean;
  actorId: string;
  now?: Date;
}

export interface CommitResult {
  importId: string;
  version: number;
  rowsImported: number;
  rowsSkipped: number;
  invoices: Array<{ id: string; number: string; store: string; total: Paisa }>;
}

const saleSource = (importId: string, storeId: string, day: string) => `${importId}:${storeId}:${day}`;

export const commitImport = async (db: Db, input: CommitInput): Promise<CommitResult> =>
  atomically(db, async (tx) => {
    const now = input.now ?? new Date();
    // One import per partner at a time, so two people cannot sell the same units twice.
    const [partner] = await tx<{ id: string }[]>`select id from retail_partners where id = ${input.partnerId} for update`;
    if (!partner) throw new ConsignmentError(`Partner ${input.partnerId} not found`, 404);
    const checked = await validateSheet(tx, input.partnerId, input.csv, now);
    if (checked.fileErrors.length > 0) throw new ConsignmentError(checked.fileErrors.join('; '), 409, report(checked));
    if (checked.alreadyImported && !input.newVersion) {
      const { importId, version, importedAt } = checked.alreadyImported;
      throw new ConsignmentError(
        `This file was already imported (import ${importId}, version ${version}, ${formatKarachi(importedAt)}). Reverse that import, or import this one as a new version.`,
        409,
        report(checked),
      );
    }
    if (checked.invalid > 0 && !input.force) {
      throw new ConsignmentError(`${checked.invalid} of ${checked.rows.length} rows are invalid; nothing was imported. Fix them, or commit the ${checked.valid} valid rows on purpose.`, 409, report(checked));
    }
    if (checked.valid === 0) throw new ConsignmentError('No valid rows to import', 409, report(checked));

    const [next] = await tx<{ version: number }[]>`
      select coalesce(max(version), 0)::int + 1 as version from partner_sales_imports where partner_id = ${input.partnerId} and file_sha256 = ${checked.fileSha256}
    `;
    const version = next!.version;
    const [imp] = await tx<{ id: string }[]>`
      insert into partner_sales_imports (partner_id, file_name, file_sha256, version, rows_total, rows_imported, forced, imported_by)
      values (${input.partnerId}, ${input.fileName}, ${checked.fileSha256}, ${version}, ${checked.rows.length}, ${checked.valid}, ${checked.invalid > 0}, ${input.actorId})
      returning id
    `;
    const importId = imp!.id;
    const location = await partnerLocation(tx, input.partnerId);
    const customer = await locationId(tx, 'customer');
    const saleIds = new Map<number, string>();
    for (const r of checked.validRows) {
      const [sale] = await tx<{ id: string }[]>`
        insert into partner_sales (import_id, row_number, sale_date, variant_id, store_id, qty, unit_price_paisa, tax_paisa, unit_cost_paisa)
        values (${importId}, ${r.row}, ${r.saleDate}, ${r.variantId}, ${r.storeId}, ${r.qty}, ${big(r.unitPrice)}, ${big(r.tax)}, ${big(r.unitCost)})
        returning id
      `;
      saleIds.set(r.row, sale!.id);
      await recordMove(tx, {
        variantId: r.variantId,
        qty: r.qty,
        from: location.id,
        to: customer,
        reason: 'consignment_sale',
        refType: 'partner_sale',
        refId: sale!.id,
        actorId: input.actorId,
        occurredAt: endOfKarachiDay(r.saleDate),
      });
    }

    // The sale and its cost, per brand and sale day: revenue on the day the partner sold.
    const groups = new Map<string, ValidRow[]>();
    for (const r of checked.validRows) {
      const key = `${r.storeId}|${r.saleDate}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const [key, rows] of groups) {
      const [storeId, day] = key.split('|') as [string, string];
      await postConsignmentSale(tx, {
        saleId: saleSource(importId, storeId, day),
        partnerId: input.partnerId,
        storeId,
        net: sum(rows.map((r) => paisa(BigInt(r.qty) * r.unitPrice))),
        tax: sum(rows.map((r) => r.tax)),
        cost: sum(rows.map((r) => paisa(BigInt(r.qty) * r.unitCost))),
        date: day,
        postedBy: input.actorId,
      });
    }

    // One invoice per brand on the sheet.
    const invoices: CommitResult['invoices'] = [];
    const stores = await tx<{ id: string; key: string }[]>`select id, key from stores`;
    for (const storeId of [...new Set(checked.validRows.map((r) => r.storeId))].sort()) {
      const rows = checked.validRows.filter((r) => r.storeId === storeId);
      const storeKey = stores.find((s) => s.id === storeId)!.key;
      const total = sum(rows.map((r) => add(paisa(BigInt(r.qty) * r.unitPrice), r.tax)));
      const number = `CI-${importId.padStart(5, '0')}-${storeKey.toUpperCase()}`;
      const [invoice] = await tx<{ id: string }[]>`
        insert into invoices (partner_id, store_id, number, issued_on, total_paisa, note, import_id)
        values (${input.partnerId}, ${storeId}, ${number}, ${karachiDay(now)}, ${big(total)}, ${`Sales reported in ${input.fileName}`}, ${importId})
        returning id
      `;
      for (const r of rows) {
        await tx`
          insert into invoice_lines (invoice_id, variant_id, description, qty, unit_price_paisa, tax_paisa, total_paisa)
          values (${invoice!.id}, ${r.variantId}, ${`${r.sku}, sold ${r.saleDate}`}, ${r.qty}, ${big(r.unitPrice)}, ${big(r.tax)},
                  ${big(add(paisa(BigInt(r.qty) * r.unitPrice), r.tax))})
        `;
      }
      invoices.push({ id: invoice!.id, number, store: storeKey, total });
    }
    await audit(tx, input.actorId, 'consignment.import', 'partner_sales_imports', importId, {
      partnerId: input.partnerId,
      fileName: input.fileName,
      version,
      rowsImported: checked.valid,
      rowsSkipped: checked.invalid,
      skipped: checked.rows.filter((r) => !r.ok).map((r) => r.row),
      net: checked.net.toString(),
    });
    return { importId, version, rowsImported: checked.valid, rowsSkipped: checked.invalid, invoices };
  });

/** Undoes an import as a unit: the units go back to the partner, every entry is reversed, the invoices are voided. */
export const reverseImport = async (db: Db, input: { importId: string; reason: string; actorId: string; now?: Date }): Promise<{ entriesReversed: number; unitsRestored: number }> =>
  atomically(db, async (tx) => {
    const now = input.now ?? new Date();
    const [imp] = await tx<{ partner_id: string; reversed_at: Date | null }[]>`
      select partner_id, reversed_at from partner_sales_imports where id = ${input.importId} for update
    `;
    if (!imp) throw new ConsignmentError(`Import ${input.importId} not found`, 404);
    if (imp.reversed_at) throw new ConsignmentError('The import is already reversed');
    const location = await partnerLocation(tx, imp.partner_id);
    const customer = await locationId(tx, 'customer');
    const sales = await tx<{ id: string; variant_id: string; qty: number }[]>`select id, variant_id, qty from partner_sales where import_id = ${input.importId} order by id`;
    for (const sale of sales) {
      await recordMove(tx, {
        variantId: sale.variant_id,
        qty: sale.qty,
        from: customer,
        to: location.id,
        reason: 'consignment_sale_reversed',
        refType: 'partner_sale_reversal',
        refId: sale.id,
        actorId: input.actorId,
        occurredAt: now,
        note: input.reason,
      });
    }
    const entries = await tx<{ id: string }[]>`
      select id from journal_entries
      where source_type in ('consignment_sale', 'consignment_cogs') and source_id like ${`${input.importId}:%`} and reversed_by is null
      order by id
    `;
    for (const entry of entries) {
      await reverseEntry(tx, entry.id, { date: karachiDay(now), memo: `Import ${input.importId} reversed`, postedBy: input.actorId, rollForward: true });
    }
    await tx`update invoices set voided_at = ${now} where import_id = ${input.importId} and voided_at is null`;
    await tx`update partner_sales_imports set reversed_at = ${now}, reversed_by = ${input.actorId}, reversal_reason = ${input.reason} where id = ${input.importId}`;
    await audit(tx, input.actorId, 'consignment.import_reverse', 'partner_sales_imports', input.importId, {
      reason: input.reason,
      entriesReversed: entries.length,
      unitsRestored: sales.reduce((n, s) => n + s.qty, 0),
    });
    return { entriesReversed: entries.length, unitsRestored: sales.reduce((n, s) => n + s.qty, 0) };
  });

export interface ImportRow {
  id: string;
  partnerId: string;
  partner: string;
  fileName: string;
  version: number;
  rowsTotal: number;
  rowsImported: number;
  forced: boolean;
  importedBy: string;
  importedAt: Date;
  reversedAt: Date | null;
  reversalReason: string | null;
  net: Paisa;
}

export const listImports = async (db: Db, partnerId?: string): Promise<ImportRow[]> => {
  const rows = await db<{
    id: string; partner_id: string; partner: string; file_name: string; version: number; rows_total: number; rows_imported: number; forced: boolean;
    imported_by: string; imported_at: Date; reversed_at: Date | null; reversal_reason: string | null; net: string;
  }[]>`
    select i.id, i.partner_id, p.name as partner, i.file_name, i.version, i.rows_total, i.rows_imported, i.forced, u.name as imported_by, i.imported_at,
           i.reversed_at, i.reversal_reason,
           (select coalesce(sum(s.qty * s.unit_price_paisa), 0) from partner_sales s where s.import_id = i.id)::text as net
    from partner_sales_imports i join retail_partners p on p.id = i.partner_id join users u on u.id = i.imported_by
    ${partnerId ? db`where i.partner_id = ${partnerId}` : db``}
    order by i.imported_at desc, i.id desc
  `;
  return rows.map((r) => ({
    id: r.id,
    partnerId: r.partner_id,
    partner: r.partner,
    fileName: r.file_name,
    version: r.version,
    rowsTotal: r.rows_total,
    rowsImported: r.rows_imported,
    forced: r.forced,
    importedBy: r.imported_by,
    importedAt: r.imported_at,
    reversedAt: r.reversed_at,
    reversalReason: r.reversal_reason,
    net: readPaisa(r.net),
  }));
};

