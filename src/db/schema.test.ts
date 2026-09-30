import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { sslOptions } from '../db.js';
import { type TestSchema, createTestSchema, skipWithoutDb } from '../test/db.js';
import { migrate } from './migrate.js';

describe('sslOptions', () => {
  it('requires TLS for Neon and other remote hosts', () => {
    assert.deepEqual(sslOptions('postgres://u:p@ep-example.ap-southeast-1.aws.neon.tech/db'), { ssl: 'require' });
  });

  it('skips TLS for a local scratch database', () => {
    assert.deepEqual(sslOptions('postgres://postgres:x@localhost:5433/postgres'), { ssl: false });
    assert.deepEqual(sslOptions('postgres://postgres:x@127.0.0.1:5433/postgres'), { ssl: false });
  });

  it('lets a URL that names its own sslmode decide', () => {
    assert.deepEqual(sslOptions('postgres://u:p@db.example.com/db?sslmode=disable'), {});
    assert.deepEqual(sslOptions('postgres://u:p@localhost/db?sslmode=require'), {});
  });
});

describe('Batch A schema', { skip: skipWithoutDb }, () => {
  let schema: TestSchema;

  before(async () => {
    schema = await createTestSchema();
    await migrate(schema.sql);
  });

  after(async () => {
    await schema?.drop();
  });

  const columns = async (table: string): Promise<string[]> => {
    const rows = await schema.sql`
      select column_name from information_schema.columns
      where table_schema = ${schema.name} and table_name = ${table}
    `;
    return rows.map((r) => String(r['column_name']));
  };

  it('creates exactly the Batch A tables', async () => {
    const rows = await schema.sql`
      select table_name from information_schema.tables where table_schema = ${schema.name} order by table_name
    `;
    assert.deepEqual(
      rows.map((r) => r['table_name']),
      ['app_settings', 'audit_log', 'integration_cursors', 'postex_accounts', 'schema_migrations', 'stores', 'sync_runs', 'users'],
    );
  });

  it('gives mutable tables created_at and updated_at, and append-only ones a single timestamp', async () => {
    for (const table of ['stores', 'postex_accounts', 'users', 'app_settings', 'integration_cursors']) {
      const names = await columns(table);
      assert.ok(names.includes('created_at') && names.includes('updated_at'), table);
    }
    // An audit entry and a sync run are written once; their own time column is their creation.
    assert.ok((await columns('audit_log')).includes('at'));
    assert.ok((await columns('sync_runs')).includes('started_at'));
  });

  it('indexes the lookups later tasks make', async () => {
    const rows = await schema.sql`select indexname from pg_indexes where schemaname = ${schema.name}`;
    const names = new Set(rows.map((r) => String(r['indexname'])));
    for (const index of [
      'stores_key_key',
      'stores_shop_domain_key',
      'postex_accounts_key_key',
      'postex_accounts_store_id_idx',
      'users_email_key',
      'audit_log_entity_idx',
      'audit_log_actor_idx',
      'audit_log_at_idx',
      'sync_runs_job_idx',
      'sync_runs_unfinished_idx',
      'integration_cursors_pkey',
    ]) {
      assert.ok(names.has(index), index);
    }
  });

  it('moves updated_at on a real change and not on a no-op update', async () => {
    await schema.sql`insert into app_settings (key, value) values ('alerts', '{"stuckDays": 7}')`;
    const [first] = await schema.sql`select updated_at from app_settings where key = 'alerts'`;

    await schema.sql`update app_settings set value = '{"stuckDays": 7}' where key = 'alerts'`;
    const [same] = await schema.sql`select updated_at from app_settings where key = 'alerts'`;
    assert.deepEqual(same?.['updated_at'], first?.['updated_at']);

    await schema.sql`update app_settings set value = '{"stuckDays": 10}' where key = 'alerts'`;
    const [changed] = await schema.sql`select updated_at from app_settings where key = 'alerts'`;
    assert.ok((changed?.['updated_at'] as Date) > (first?.['updated_at'] as Date));
  });

  it('keeps audit_log append-only', async () => {
    await schema.sql`insert into audit_log (action, entity, entity_id) values ('seed', 'stores', '1')`;
    await assert.rejects(schema.sql`update audit_log set action = 'edited'`, /append-only: UPDATE/);
    await assert.rejects(schema.sql`delete from audit_log`, /append-only: DELETE/);
  });

  it('rejects rows that break the stated rules', async () => {
    const cases: Array<[string, Promise<unknown>]> = [
      ['unknown store key', schema.sql`insert into stores (key, label, shop_domain) values ('other', 'x', 'x.myshopify.com')`],
      ['non-Shopify domain', schema.sql`insert into stores (key, label, shop_domain) values ('nur', 'x', 'example.com')`],
      ['non-PKR currency', schema.sql`insert into stores (key, label, shop_domain, currency) values ('nur', 'x', 'x.myshopify.com', 'USD')`],
      ['mixed-case email', schema.sql`insert into users (email, name, role) values ('Owner@Example.com', 'x', 'owner')`],
      ['unknown role', schema.sql`insert into users (email, name, role) values ('a@example.com', 'x', 'admin')`],
      ['finished run still running', schema.sql`insert into sync_runs (job, account_ref, status, finished_at) values ('j', 'nur', 'running', now())`],
      ['succeeded run with no finish time', schema.sql`insert into sync_runs (job, account_ref, status) values ('j', 'nur', 'succeeded')`],
    ];
    for (const [label, query] of cases) {
      await assert.rejects(query, /violates check constraint/, label);
    }
  });
});
