import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { getAuthUser, isAdmin } from '../../_lib/auth';

// Admin: list registered customers with their category and roles.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!isAdmin(user)) return error('Not authorised', 403);

  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.full_name, u.pricing_category_id, pc.label AS category_label, u.created_at
     FROM users u JOIN pricing_categories pc ON pc.id = u.pricing_category_id ORDER BY u.created_at DESC`,
  ).all<Record<string, unknown>>();

  const roleRows = await env.DB.prepare(
    'SELECT ur.user_id, r.name AS role FROM user_roles ur JOIN roles r ON r.id = ur.role_id',
  ).all<{ user_id: string; role: string }>();
  const roleMap: Record<string, string[]> = {};
  for (const r of roleRows.results) (roleMap[r.user_id] ??= []).push(r.role);

  return json(rows.results.map((u) => ({ ...u, roles: roleMap[u.id as string] ?? [] })));
};
