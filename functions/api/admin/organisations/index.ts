import type { Env } from '../../../_lib/http';
import { json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';

// Admin: search organisations. Query: q (name or contact email)
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const q = new URL(request.url).searchParams.get('q')?.trim();
  const rows = await env.DB.prepare(
    `SELECT o.id, o.name, t.label AS organisation_type, pc.label AS category_label, o.pricing_category_id, o.contact_email,
            (SELECT COUNT(*) FROM organisation_memberships m WHERE m.organisation_id = o.id) AS member_count,
            (SELECT COUNT(*) FROM bookings b WHERE b.organisation_id = o.id) AS booking_count
     FROM organisations o
     JOIN organisation_types t ON t.id = o.organisation_type_id
     JOIN pricing_categories pc ON pc.id = o.pricing_category_id
     ${q ? 'WHERE o.name LIKE ? OR o.contact_email LIKE ?' : ''}
     ORDER BY o.name LIMIT 500`,
  )
    .bind(...(q ? [`%${q}%`, `%${q}%`] : []))
    .all();
  return json(rows.results);
};
