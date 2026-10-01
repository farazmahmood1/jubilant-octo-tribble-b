import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { type TestSchema, createTestSchema } from './db.js';

export interface Stores {
  schema: TestSchema;
  nur: string;
  organics: string;
}

/** A migrated, seeded schema with both stores, for repo tests. */
export const migratedWithStores = async (): Promise<Stores> => {
  const schema = await createTestSchema();
  await migrate(schema.sql);
  await seed(schema.sql, {
    stores: [
      { key: 'nur', label: 'NUR by Juggun', shop: 'nurbyjuggun' },
      { key: 'organics', label: "Juggun's Organics", shop: 'jugguns-organics' },
    ],
    postexAccounts: [],
  });
  const rows = await schema.sql<{ id: string; key: string }[]>`select id, key from stores`;
  const id = (key: string) => rows.find((r) => r.key === key)?.id ?? '';
  return { schema, nur: id('nur'), organics: id('organics') };
};
