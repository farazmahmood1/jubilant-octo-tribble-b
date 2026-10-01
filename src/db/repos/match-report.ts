import { parseOrderRef } from '../../domain/matching.js';
import type { Db } from './upsert.js';

/**
 * How well parcels are matched to orders, per PostEx account, and which order-number prefixes
 * the team actually types on parcels. The prefixes are what the `matching` setting needs; this
 * reads them off the data instead of guessing.
 */

/** Step 6 "done when": unmatched at most 100% − 95.4% of parcels. */
export const MAX_UNMATCHED_RATE = 0.046;

export interface PrefixCount {
  /** Upper-cased prefix, or null for a bare number such as `#1234`. */
  prefix: string | null;
  parcels: number;
  matched: number;
  /** Whether the `matching` setting already accepts this prefix for the account's store. */
  configured: boolean;
}

export interface AccountMatchReport {
  account: string;
  storeKey: string | null;
  parcels: number;
  matched: number;
  unmatched: number;
  unmatchedRate: number;
  /** Unmatched parcels with no queue row at all (open, resolved or ignored). Must be 0. */
  unmatchedWithoutItem: number;
  byMethod: Record<string, number>;
  /** Parcels whose reference is not an order number at all (blank, or free text). */
  unparsedRefs: number;
  prefixes: PrefixCount[];
  withinTarget: boolean;
}

export const matchReport = async (db: Db): Promise<AccountMatchReport[]> => {
  const [setting] = await db<{ value: { refPrefixes?: Record<string, string[]> } }[]>`select value from app_settings where key = 'matching'`;
  const configured = setting?.value.refPrefixes ?? {};
  const rows = await db<{ account: string; store_key: string | null; ref: string | null; method: string | null; has_item: boolean }[]>`
    select a.key as account, st.key as store_key, s.order_ref_number as ref, s.match_method as method,
           exists (select 1 from reconciliation_items r where r.dedupe_key = 'unmatched_shipment:' || s.id) as has_item
    from shipments s
    join postex_accounts a on a.id = s.postex_account_id
    left join stores st on st.id = a.store_id
    order by a.key
  `;

  const reports = new Map<string, AccountMatchReport>();
  for (const row of rows) {
    let report = reports.get(row.account);
    if (!report) {
      report = { account: row.account, storeKey: row.store_key, parcels: 0, matched: 0, unmatched: 0, unmatchedRate: 0, unmatchedWithoutItem: 0, byMethod: {}, unparsedRefs: 0, prefixes: [], withinTarget: true };
      reports.set(row.account, report);
    }
    report.parcels++;
    if (row.method) {
      report.matched++;
      report.byMethod[row.method] = (report.byMethod[row.method] ?? 0) + 1;
    } else {
      report.unmatched++;
      if (!row.has_item) report.unmatchedWithoutItem++;
    }
    const parsed = parseOrderRef(row.ref);
    if (!parsed) {
      report.unparsedRefs++;
      continue;
    }
    let entry = report.prefixes.find((p) => p.prefix === parsed.prefix);
    if (!entry) {
      const allowed = (row.store_key ? (configured[row.store_key] ?? []) : []).map((p) => p.toUpperCase());
      entry = { prefix: parsed.prefix, parcels: 0, matched: 0, configured: parsed.prefix === null || allowed.includes(parsed.prefix) };
      report.prefixes.push(entry);
    }
    entry.parcels++;
    if (row.method) entry.matched++;
  }

  return [...reports.values()].map((r) => {
    const unmatchedRate = r.parcels === 0 ? 0 : r.unmatched / r.parcels;
    return {
      ...r,
      unmatchedRate,
      prefixes: r.prefixes.sort((a, b) => b.parcels - a.parcels || String(a.prefix).localeCompare(String(b.prefix))),
      withinTarget: unmatchedRate <= MAX_UNMATCHED_RATE && r.unmatchedWithoutItem === 0,
    };
  });
};
