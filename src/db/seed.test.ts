import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { Sql } from '../db.js';
import { type TestSchema, createTestSchema, skipWithoutDb } from '../test/db.js';
import { migrate } from './migrate.js';
import { type SeedInput, seed } from './seed.js';

const input: SeedInput = {
  stores: [
    { key: 'nur', label: 'NUR by Juggun', shop: 'nurbyjuggun' },
    { key: 'organics', label: "Juggun's Organics", shop: 'jugguns-organics' },
  ],
  postexAccounts: [
    { key: 'nur', label: 'NUR by Juggun' },
    { key: 'organics', label: "Juggun's Organics" },
  ],
};

/** Row count and a hash of every column of every row, `updated_at` included. */
const fingerprint = async (sql: Sql, table: 'stores' | 'postex_accounts') => {
  const [row] = await sql`
    select count(*)::int as count, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as hash
    from ${sql(table)} t
  `;
  return { count: row?.['count'], hash: row?.['hash'] };
};

describe('seed', { skip: skipWithoutDb }, () => {
  let schema: TestSchema;

  before(async () => {
    schema = await createTestSchema();
    await migrate(schema.sql);
  });

  after(async () => {
    await schema?.drop();
  });

  it('seeding twice leaves identical rows', async () => {
    assert.deepEqual(await seed(schema.sql, input), { stores: 2, postexAccounts: 2 });
    const stores = await fingerprint(schema.sql, 'stores');
    const accounts = await fingerprint(schema.sql, 'postex_accounts');
    assert.equal(stores.count, 2);
    assert.equal(accounts.count, 2);

    assert.deepEqual(await seed(schema.sql, input), { stores: 0, postexAccounts: 0 });
    assert.deepEqual(await fingerprint(schema.sql, 'stores'), stores);
    assert.deepEqual(await fingerprint(schema.sql, 'postex_accounts'), accounts);
  });

  it('links each PostEx account to the store with the same key', async () => {
    const rows = await schema.sql`
      select p.key as account, s.key as store, s.shop_domain
      from postex_accounts p join stores s on s.id = p.store_id order by p.key
    `;
    assert.deepEqual(
      rows.map((r) => [r['account'], r['store'], r['shop_domain']]),
      [
        ['nur', 'nur', 'nurbyjuggun.myshopify.com'],
        ['organics', 'organics', 'jugguns-organics.myshopify.com'],
      ],
    );
  });

  it('relabels a changed store and moves only its updated_at', async () => {
    const [before] = await schema.sql`select updated_at from stores where key = 'organics'`;
    const [untouched] = await schema.sql`select updated_at from stores where key = 'nur'`;
    const relabelled = { ...input, stores: input.stores.map((s) => (s.key === 'organics' ? { ...s, label: 'Organics' } : s)) };

    assert.deepEqual(await seed(schema.sql, relabelled), { stores: 1, postexAccounts: 0 });
    const [after] = await schema.sql`select label, updated_at from stores where key = 'organics'`;
    const [nur] = await schema.sql`select updated_at from stores where key = 'nur'`;
    assert.equal(after?.['label'], 'Organics');
    assert.ok((after?.['updated_at'] as Date) > (before?.['updated_at'] as Date));
    assert.deepEqual(nur?.['updated_at'], untouched?.['updated_at']);
  });

  it('keeps a store that is no longer in config, since its data still refers to it', async () => {
    await seed(schema.sql, { stores: [input.stores[0]!], postexAccounts: [] });
    const [row] = await schema.sql`select count(*)::int as n from stores`;
    assert.equal(row?.['n'], 2);
  });

  it('registers an account before its store exists, and links it once the store arrives', async () => {
    const extra: SeedInput = { stores: [], postexAccounts: [{ key: 'legacy', label: 'Earlier account' }] };
    await seed(schema.sql, extra);
    const [unlinked] = await schema.sql`select store_id from postex_accounts where key = 'legacy'`;
    assert.equal(unlinked?.['store_id'], null);
  });
});
