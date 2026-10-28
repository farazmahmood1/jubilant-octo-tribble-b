import type { Payout } from '../../integrations/postex/mapper.js';
import { type Db, atomically } from './upsert.js';

/**
 * COD payouts (3.2 note S3): which delivered parcels PostEx has paid out, under which payment
 * receipt (CPR). `cod_payouts` and `payout_lines` are source records written by the payout sync;
 * the journal posts from them later (Step 10).
 */

/**
 * Parcels of one account that PostEx settles and that have no payout line yet: delivered ones
 * (their COD paid out) and returned ones (their return charge taken off a payout), oldest first.
 */
export const awaitingPayout = async (db: Db, postexAccountId: string, limit: number): Promise<Array<{ id: string; trackingNumber: string }>> => {
  const rows = await db<{ id: string; tracking_number: string }[]>`
    select s.id, s.tracking_number from shipments s
    where s.postex_account_id = ${postexAccountId}
      and coalesce(s.stage in ('delivered', 'returned'), s.status_code in ('0005', '0006'))
      and not exists (select 1 from payout_lines l where l.shipment_id = s.id)
    order by s.delivered_at nulls last, s.id
    limit ${limit}
  `;
  return rows.map((r) => ({ id: r.id, trackingNumber: r.tracking_number }));
};

/**
 * Records that a parcel was settled under a CPR: the payout row (one per account and CPR), and
 * the parcel's line. A delivered parcel's line is its COD less its charges with their tax, which
 * PostEx deducts before paying; a returned parcel collected nothing, so its line is minus its
 * return charge and tax, taken off that payout. The payout's amount is then re-summed from its
 * lines, never added to. Returns whether a line was written; a parcel already on a payout writes
 * nothing.
 */
export const recordPayout = async (db: Db, postexAccountId: string, shipmentId: string, payout: Payout & { cprNumber: string }): Promise<boolean> =>
  atomically(db, async (tx) => {
    const [cod] = await tx<{ id: string }[]>`
      insert into cod_payouts (postex_account_id, cpr_number, paid_at)
      values (${postexAccountId}, ${payout.cprNumber}, ${payout.paidAt ?? payout.settledAt})
      on conflict (postex_account_id, cpr_number) do update set paid_at = coalesce(cod_payouts.paid_at, excluded.paid_at)
      returning id
    `;
    if (!cod) throw new Error('Payout upsert returned no row');
    const lines = await tx`
      insert into payout_lines (cod_payout_id, shipment_id, amount_paisa)
      select ${cod.id}, s.id,
             case when coalesce(s.stage = 'delivered', s.status_code = '0005') then coalesce(s.cod_amount_paisa, 0) else 0 end
             - coalesce((select sum(c.amount_paisa) from shipment_charges c where c.shipment_id = s.id and c.kind in ('forward', 'forward_tax', 'reversal', 'reversal_tax')), 0)
      from shipments s
      where s.id = ${shipmentId} and not exists (select 1 from payout_lines l where l.shipment_id = s.id)
      on conflict do nothing
      returning id
    `;
    await tx`
      update cod_payouts p set amount_paisa = t.total
      from (select coalesce(sum(amount_paisa), 0)::bigint as total from payout_lines where cod_payout_id = ${cod.id}) t
      where p.id = ${cod.id} and p.amount_paisa is distinct from t.total
    `;
    return lines.length > 0;
  });
