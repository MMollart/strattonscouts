import type { Env } from '../../_lib/http';
import { json } from '../../_lib/http';
import { requirePermission } from '../../_lib/auth';

// Super Admin: list administrators and their roles.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'admins.manage');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.full_name, r.name AS role, ur.granted_at, ur.granted_by
     FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id
     ORDER BY u.full_name`,
  ).all();
  return json(rows.results);
};
