import type { Env } from '../../../../_lib/http';
import { json } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { resourceNamesSql } from '../../../../_lib/availability-sql';

// Admin: who accepted an agreement, for which booking and version (newest first).
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare(
    `SELECT a.id, a.booking_id, b.reference AS booking_reference, ${resourceNamesSql('b')} AS resource_name, a.version_id, v.version_number, a.accepted_at,
            u.full_name AS accepted_by_name, s.on_behalf_of IS NOT NULL AS on_behalf, a.amendment_id
     FROM agreement_acceptances a
     JOIN bookings b ON b.id = a.booking_id JOIN resources r ON r.id = b.resource_id
     JOIN agreement_versions v ON v.id = a.version_id JOIN agreement_signatures s ON s.id = a.signature_id
     JOIN users u ON u.id = a.accepted_by
     WHERE a.template_id = ? ORDER BY a.accepted_at DESC LIMIT 500`,
  )
    .bind(String(params.id))
    .all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({ ...r, on_behalf: !!r.on_behalf })));
};
