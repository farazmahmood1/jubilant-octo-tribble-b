import type { Db } from './upsert.js';

/**
 * The damaged register: every returned parcel a person checked in as damaged, with what was in
 * it, who it was sent to, each date on its way back, who found it damaged, and the cost written
 * off. A read model over check-ins, stock moves and the journal; nothing here writes.
 */

export interface DamagedRow {
  checkInId: string;
  shipmentId: string;
  trackingNumber: string;
  account: string;
  store: 'nur' | 'organics' | null;
  orderId: string | null;
  orderNumber: string | null;
  customerName: string | null;
  /** Null for a role that may not see phone numbers. */
  phone: string | null;
  city: string | null;
  codPaisa: string | null;
  bookedAt: Date | null;
  /** The first failed attempt or return step: when the parcel stopped going forward. */
  refusedAt: Date | null;
  failureReason: string | null;
  /** PostEx said it was back at the merchant (0006). */
  returnedAt: Date | null;
  damagedAt: Date;
  damagedBy: string;
  note: string | null;
  items: Array<{ variantId: string; title: string; sku: string | null; qty: number }>;
  units: number;
  /** The cost written off in the journal; null when the products have no cost yet. */
  writtenOffPaisa: string | null;
}

export interface DamagedFilter {
  store?: 'nur' | 'organics';
  from?: string;
  to?: string;
  search?: string;
}

export const damagedRegister = async (db: Db, f: DamagedFilter, opts: { phones: boolean }): Promise<{ rows: DamagedRow[]; units: number; writtenOffPaisa: string }> => {
  const like = f.search ? `%${f.search.trim().replace(/[%_\\]/g, '\\$&')}%` : null;
  const rows = await db<
    {
      check_in_id: string; shipment_id: string; tracking_number: string; account: string; store: 'nur' | 'organics' | null; order_id: string | null; order_number: string | null;
      customer_name: string | null; phone: string | null; city: string | null; cod: string | null; booked_at: Date | null; refused_at: Date | null; failure_reason: string | null;
      returned_at: Date | null; damaged_at: Date; damaged_by: string; note: string | null; items: DamagedRow['items'] | null; written_off: string | null;
    }[]
  >`
    select c.id as check_in_id, s.id as shipment_id, s.tracking_number, a.key as account, coalesce(ost.key, ast.key) as store,
           o.id as order_id, o.order_number, cu.name as customer_name, coalesce(cu.phone_e164, s.customer_phone) as phone,
           coalesce(ad.city, s.city) as city, s.cod_amount_paisa::text as cod, s.booked_at, s.last_failure_reason as failure_reason,
           (select min(e.occurred_at) from shipment_events e where e.shipment_id = s.id and e.code in ('0013', '0040')) as refused_at,
           (select min(e.occurred_at) from shipment_events e where e.shipment_id = s.id and e.code = '0006') as returned_at,
           c.checked_in_at as damaged_at, u.name as damaged_by, c.note,
           (select json_agg(json_build_object('variantId', v.id::text, 'title', p.title || case when v.title = 'Default Title' then '' else ' · ' || v.title end, 'sku', v.sku, 'qty', m.qty) order by p.title)
              from (select variant_id, sum(qty)::int as qty from stock_moves where ref_type = 'return_check_in' and ref_id = c.id::text group by variant_id) m
              join variants v on v.id = m.variant_id join products p on p.id = v.product_id) as items,
           (select sum(l.debit_paisa)::text from journal_entries j join journal_lines l on l.entry_id = j.id join accounts ac on ac.id = l.account_id
              where j.source_type = 'shipment_write_off' and j.source_id = s.id::text and j.reversed_by is null and ac.code = '6200') as written_off
    from return_check_ins c
    join shipments s on s.id = c.shipment_id
    join postex_accounts a on a.id = s.postex_account_id
    left join stores ast on ast.id = a.store_id
    left join orders o on o.id = s.order_id
    left join stores ost on ost.id = o.store_id
    left join customers cu on cu.id = o.customer_id
    left join addresses ad on ad.id = o.shipping_address_id
    join users u on u.id = c.actor_id
    where c.outcome = 'damaged'
      ${f.store ? db`and coalesce(ost.key, ast.key) = ${f.store}` : db``}
      ${f.from ? db`and (c.checked_in_at at time zone 'Asia/Karachi')::date >= ${f.from}::date` : db``}
      ${f.to ? db`and (c.checked_in_at at time zone 'Asia/Karachi')::date <= ${f.to}::date` : db``}
      ${like ? db`and (s.tracking_number ilike ${like} or o.order_number ilike ${like} or cu.name ilike ${like})` : db``}
    order by c.checked_in_at desc, c.id desc
    limit 500
  `;
  const mapped = rows.map((r): DamagedRow => {
    const items = r.items ?? [];
    return {
      checkInId: r.check_in_id,
      shipmentId: r.shipment_id,
      trackingNumber: r.tracking_number,
      account: r.account,
      store: r.store,
      orderId: r.order_id,
      orderNumber: r.order_number,
      customerName: r.customer_name,
      phone: opts.phones ? r.phone : null,
      city: r.city,
      codPaisa: r.cod,
      bookedAt: r.booked_at,
      refusedAt: r.refused_at,
      failureReason: r.failure_reason,
      returnedAt: r.returned_at,
      damagedAt: r.damaged_at,
      damagedBy: r.damaged_by,
      note: r.note,
      items,
      units: items.reduce((n, i) => n + i.qty, 0),
      writtenOffPaisa: r.written_off,
    };
  });
  return {
    rows: mapped,
    units: mapped.reduce((n, r) => n + r.units, 0),
    writtenOffPaisa: mapped.reduce((n, r) => n + BigInt(r.writtenOffPaisa ?? '0'), 0n).toString(),
  };
};
