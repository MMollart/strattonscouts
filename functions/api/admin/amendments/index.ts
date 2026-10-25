import type { Env } from '../../../_lib/http';
import { json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { effectiveStatusSql, resourceListNamesSql } from '../../../_lib/availability-sql';

// Admin: change requests, pending first by default (?status=pending|approved|rejected|withdrawn).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const status = new URL(request.url).searchParams.get('status') ?? 'pending';
  const rows = await env.DB.prepare(
    `SELECT a.id, a.booking_id, b.reference, ${effectiveStatusSql('b')} AS booking_status, a.status,
            a.from_resource_id, ${resourceListNamesSql('a.from_resource_ids', 'a.from_resource_id')} AS from_resource_name, a.from_starts_at, a.from_ends_at, a.from_total_pence,
            a.to_resource_id, ${resourceListNamesSql('a.to_resource_ids', 'a.to_resource_id')} AS to_resource_name, a.to_starts_at, a.to_ends_at, a.to_total_pence,
            a.customer_note, a.decision_note, a.created_at, u.full_name AS customer_name, o.name AS organisation_name
     FROM booking_amendments a JOIN bookings b ON b.id = a.booking_id JOIN users u ON u.id = b.user_id
     LEFT JOIN organisations o ON o.id = b.organisation_id
     WHERE a.status = ? ORDER BY a.created_at LIMIT 200`,
  )
    .bind(status)
    .all();
  return json(rows.results);
};
