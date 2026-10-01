import { type Db, atomically } from './upsert.js';

/**
 * Influencers and their discount codes (Batch H). The influencer breakdown attributes an order to
 * whoever owns the first of its codes in the order's store, read on every report (rule 7), so
 * assigning or removing a code re-attributes past orders too: the codes are who the influencer
 * is, not a dated event. Every change is audited with its actor (rule 8).
 */

export class InfluencerError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409 = 409) {
    super(message);
    this.name = 'InfluencerError';
    this.status = status;
  }
}

export interface InfluencerInput {
  handle: string;
  name: string;
  city?: string | null;
  followers?: number | null;
  niche?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export interface InfluencerCode {
  id: string;
  store: string;
  code: string;
  /** Orders that used the code, any case, in its store. */
  orders: number;
}

export interface Influencer {
  id: string;
  handle: string;
  name: string;
  city: string | null;
  followers: number | null;
  niche: string | null;
  notes: string | null;
  isActive: boolean;
  codes: InfluencerCode[];
}

const audit = (db: Db, actorId: string, action: string, entityId: string, before: unknown, after: unknown) =>
  db`
    insert into audit_log (actor_id, action, entity, entity_id, before, after)
    values (${actorId}, ${action}, 'influencers', ${entityId}, ${before === null ? null : db.json(before as never)}, ${after === null ? null : db.json(after as never)})
  `;

/** A duplicate handle or code is a rule the request broke, not a server fault. */
const asConflict = (message: string) => (error: unknown): never => {
  if (error instanceof Error && 'code' in error && (error as { code?: string }).code === '23505') throw new InfluencerError(message);
  throw error;
};

export const listInfluencers = async (db: Db): Promise<Influencer[]> => {
  const rows = await db<{ id: string; handle: string; name: string; city: string | null; followers: number | null; niche: string | null; notes: string | null; is_active: boolean }[]>`
    select id, handle, name, city, followers, niche, notes, is_active from influencers order by is_active desc, lower(name), id
  `;
  const codes = await db<{ id: string; influencer_id: string; store: string; code: string; orders: number }[]>`
    select ic.id, ic.influencer_id, st.key as store, ic.discount_code as code,
           (select count(*)::int from orders o
            where o.store_id = ic.store_id and exists (select 1 from unnest(o.discount_codes) used (code) where lower(used.code) = lower(ic.discount_code))) as orders
    from influencer_codes ic join stores st on st.id = ic.store_id
    order by st.key, lower(ic.discount_code)
  `;
  return rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    name: r.name,
    city: r.city,
    followers: r.followers,
    niche: r.niche,
    notes: r.notes,
    isActive: r.is_active,
    codes: codes.filter((c) => c.influencer_id === r.id).map((c) => ({ id: c.id, store: c.store, code: c.code, orders: c.orders })),
  }));
};

export const createInfluencer = async (db: Db, input: InfluencerInput, actorId: string): Promise<string> =>
  atomically(db, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into influencers (handle, name, city, followers, niche, notes, is_active)
      values (${input.handle}, ${input.name}, ${input.city ?? null}, ${input.followers ?? null}, ${input.niche ?? null}, ${input.notes ?? null}, ${input.isActive ?? true})
      returning id
    `.catch(asConflict(`@${input.handle} is already on the list`));
    await audit(tx, actorId, 'influencer.create', row!.id, null, input);
    return row!.id;
  });

export const updateInfluencer = async (db: Db, id: string, input: Partial<InfluencerInput>, actorId: string): Promise<void> =>
  atomically(db, async (tx) => {
    const [before] = await tx<{ handle: string; name: string; city: string | null; followers: number | null; niche: string | null; notes: string | null; is_active: boolean }[]>`
      select handle, name, city, followers, niche, notes, is_active from influencers where id = ${id} for update
    `;
    if (!before) throw new InfluencerError(`Influencer ${id} not found`, 404);
    const next = {
      handle: input.handle ?? before.handle,
      name: input.name ?? before.name,
      city: input.city !== undefined ? input.city : before.city,
      followers: input.followers !== undefined ? input.followers : before.followers,
      niche: input.niche !== undefined ? input.niche : before.niche,
      notes: input.notes !== undefined ? input.notes : before.notes,
      is_active: input.isActive ?? before.is_active,
    };
    await tx`
      update influencers set handle = ${next.handle}, name = ${next.name}, city = ${next.city}, followers = ${next.followers},
             niche = ${next.niche}, notes = ${next.notes}, is_active = ${next.is_active}
      where id = ${id}
    `.catch(asConflict(`@${next.handle} is already on the list`));
    await audit(tx, actorId, 'influencer.update', id, before, next);
  });

/** Assigns a discount code in one store. Returns the code's id and how many orders it already attributes. */
export const addCode = async (db: Db, influencerId: string, input: { store: 'nur' | 'organics'; code: string }, actorId: string): Promise<{ id: string; orders: number }> =>
  atomically(db, async (tx) => {
    const [influencer] = await tx`select 1 from influencers where id = ${influencerId}`;
    if (!influencer) throw new InfluencerError(`Influencer ${influencerId} not found`, 404);
    const [owner] = await tx<{ name: string }[]>`
      select i.name from influencer_codes ic join influencers i on i.id = ic.influencer_id join stores st on st.id = ic.store_id
      where st.key = ${input.store} and lower(ic.discount_code) = lower(${input.code})
    `;
    if (owner) throw new InfluencerError(`${input.code} is already ${owner.name}'s code on ${input.store}`);
    const [row] = await tx<{ id: string; orders: number }[]>`
      insert into influencer_codes (influencer_id, store_id, discount_code)
      select ${influencerId}, id, ${input.code} from stores where key = ${input.store}
      returning id, (select count(*)::int from orders o
                     where o.store_id = influencer_codes.store_id
                       and exists (select 1 from unnest(o.discount_codes) used (code) where lower(used.code) = lower(${input.code}))) as orders
    `.catch(asConflict(`${input.code} is already assigned on ${input.store}`));
    await audit(tx, actorId, 'influencer.add_code', influencerId, null, { codeId: row!.id, store: input.store, code: input.code });
    return { id: row!.id, orders: row!.orders };
  });

export const removeCode = async (db: Db, influencerId: string, codeId: string, actorId: string): Promise<void> =>
  atomically(db, async (tx) => {
    const [row] = await tx<{ store: string; code: string }[]>`
      delete from influencer_codes ic using stores st
      where ic.id = ${codeId} and ic.influencer_id = ${influencerId} and st.id = ic.store_id
      returning st.key as store, ic.discount_code as code
    `;
    if (!row) throw new InfluencerError(`Code ${codeId} is not this influencer's`, 404);
    await audit(tx, actorId, 'influencer.remove_code', influencerId, { codeId, store: row.store, code: row.code }, null);
  });

/** Discount codes customers used that nobody owns yet, most used first: the ones worth assigning. */
export const unassignedCodes = async (db: Db, store?: 'nur' | 'organics'): Promise<Array<{ store: string; code: string; orders: number; lastUsedAt: Date }>> => {
  const rows = await db<{ store: string; code: string; orders: number; last_used_at: Date }[]>`
    select st.key as store, min(used.code) as code, count(distinct o.id)::int as orders, max(o.placed_at) as last_used_at
    from orders o cross join lateral unnest(o.discount_codes) used (code)
    join stores st on st.id = o.store_id
    where not exists (select 1 from influencer_codes ic where ic.store_id = o.store_id and lower(ic.discount_code) = lower(used.code))
      ${store ? db`and st.key = ${store}` : db``}
    group by st.key, lower(used.code)
    order by count(distinct o.id) desc, st.key, lower(used.code)
    limit 200
  `;
  return rows.map((r) => ({ store: r.store, code: r.code, orders: r.orders, lastUsedAt: r.last_used_at }));
};
