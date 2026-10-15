import type { Env } from '../../_lib/http';
import { json } from '../../_lib/http';
import { requirePermission } from '../../_lib/auth';

// Admin: email history (?booking_id=, ?status=, ?q= recipient or reference).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const url = new URL(request.url);
  const clauses: string[] = [];
  const binds: unknown[] = [];
  const bookingId = url.searchParams.get('booking_id');
  const status = url.searchParams.get('status');
  const q = url.searchParams.get('q');
  if (bookingId) { clauses.push('e.booking_id = ?'); binds.push(bookingId); }
  if (status) { clauses.push('e.status = ?'); binds.push(status); }
  if (q) { clauses.push('(e.recipient LIKE ? OR e.booking_reference LIKE ? OR b.reference LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = await env.DB.prepare(
    `SELECT e.id, e.recipient, e.template, e.subject, e.status, e.error, e.provider_ref, e.attempts, e.next_attempt_at,
            e.created_at, e.sent_at, e.booking_id, COALESCE(e.booking_reference, b.reference) AS booking_reference
     FROM email_events e LEFT JOIN bookings b ON b.id = e.booking_id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY e.created_at DESC LIMIT 200`,
  )
    .bind(...binds)
    .all();
  return json(rows.results);
};
