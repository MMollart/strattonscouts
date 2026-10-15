import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { getAuthUser, isAdmin } from '../../_lib/auth';

// Admin: list/search/filter bookings including customer contact information.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!isAdmin(user)) return error('Not authorised', 403);

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const resourceId = url.searchParams.get('resource_id');
  const q = url.searchParams.get('q');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (status) { clauses.push('b.status = ?'); binds.push(status); }
  if (resourceId) { clauses.push('b.resource_id = ?'); binds.push(resourceId); }
  if (from) { clauses.push('b.ends_at >= ?'); binds.push(from); }
  if (to) { clauses.push('b.starts_at <= ?'); binds.push(to); }
  if (q) { clauses.push('(b.reference LIKE ? OR u.full_name LIKE ? OR u.email LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await env.DB.prepare(
    `SELECT b.id, b.reference, b.status, b.starts_at, b.ends_at, b.total_amount_pence,
            r.name AS resource_name, u.full_name AS customer_name, u.email AS customer_email
     FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     ${where} ORDER BY b.starts_at DESC LIMIT 200`,
  )
    .bind(...binds)
    .all();
  return json(rows.results);
};
