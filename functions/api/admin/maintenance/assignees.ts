import type { Env } from '../../../_lib/http';
import { json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';

// Admin: administrators maintenance can be assigned to (FR22 §4.2).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare(
    'SELECT DISTINCT u.id, u.full_name FROM users u JOIN user_roles ur ON ur.user_id = u.id ORDER BY u.full_name',
  ).all<{ id: string; full_name: string }>();
  return json(rows.results);
};
