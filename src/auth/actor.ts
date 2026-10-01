import type { SessionUser } from './session.js';
import type { Db } from '../db/repos/upsert.js';

/**
 * The `users` row for a signed-in session, created on first use. Until real accounts land
 * (Step 15) the session comes from the single sign-in in the environment; giving it a users row
 * lets every audited action name its actor by id now (rule 8), and Step 15 keeps the same rows.
 */
export const actorId = async (db: Db, user: SessionUser): Promise<string> => {
  const email = user.email.trim().toLowerCase();
  const [row] = await db<{ id: string }[]>`
    insert into users (email, name, role) values (${email}, ${user.name || email}, ${user.role})
    on conflict (email) do update set name = users.name
    returning id
  `;
  if (!row) throw new Error('Actor upsert returned no row');
  return row.id;
};
