import type { Env } from '../_lib/http';
import { error, json } from '../_lib/http';
import { getAuthUser } from '../_lib/auth';

// The signed-in user's keys, fobs and equipment currently on loan to them.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const rows = await env.DB.prepare(
    `SELECT a.id, a.name, a.reference, t.name AS asset_type_name, x.assigned_at
     FROM asset_assignments x JOIN assets a ON a.id = x.asset_id JOIN asset_types t ON t.id = a.asset_type_id
     WHERE x.user_id = ? AND x.returned_at IS NULL ORDER BY x.assigned_at`,
  )
    .bind(user.id)
    .all();
  return json(rows.results);
};
