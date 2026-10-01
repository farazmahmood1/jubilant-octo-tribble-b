import type { Db } from './upsert.js';

/** Where a sync resumes. The cursor is opaque here: each job decides what it holds. */
export const getCursor = async (db: Db, job: string, accountRef: string): Promise<string | null> => {
  const [row] = await db<{ cursor: string }[]>`
    select cursor from integration_cursors where job = ${job} and account_ref = ${accountRef}
  `;
  return row?.cursor ?? null;
};

export const setCursor = async (db: Db, job: string, accountRef: string, cursor: string): Promise<void> => {
  await db`
    insert into integration_cursors (job, account_ref, cursor) values (${job}, ${accountRef}, ${cursor})
    on conflict (job, account_ref) do update set cursor = excluded.cursor
  `;
};
