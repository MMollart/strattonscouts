import type { Env } from '../../_lib/http';
import { json } from '../../_lib/http';
import { requirePermission } from '../../_lib/auth';
import { decryptAtRest } from '../../_lib/crypto';
import { activeBookingSql, canonicalIso, effectiveStatusSql } from '../../_lib/availability-sql';

// Admin: list/search/filter bookings including customer contact information.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const resourceId = url.searchParams.get('resource_id');
  const q = url.searchParams.get('q');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const organisationId = url.searchParams.get('organisation_id');
  const userId = url.searchParams.get('user_id');
  const resourceIds = url.searchParams.get('resource_ids');
  const excludeInactive = url.searchParams.get('active_only') === '1';
  // The calendar (FR09) asks for a whole month at a time.
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 2000);

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (status) { clauses.push(`${effectiveStatusSql('b')} = ?`); binds.push(status); }
  if (resourceId) { clauses.push('b.resource_id = ?'); binds.push(resourceId); }
  if (organisationId) { clauses.push('b.organisation_id = ?'); binds.push(organisationId); }
  if (userId) { clauses.push('b.user_id = ?'); binds.push(userId); }
  if (resourceIds) {
    const ids = resourceIds.split(',').filter(Boolean).slice(0, 50);
    if (ids.length) { clauses.push(`b.resource_id IN (${ids.map(() => '?').join(', ')})`); binds.push(...ids); }
  }
  if (excludeInactive) { clauses.push(activeBookingSql('b')); }
  if (from && !Number.isNaN(Date.parse(from))) { clauses.push('b.ends_at >= ?'); binds.push(canonicalIso(from)); }
  if (to && !Number.isNaN(Date.parse(to))) { clauses.push('b.starts_at <= ?'); binds.push(canonicalIso(to)); }
  if (q) { clauses.push('(b.reference LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR o.name LIKE ?)'); binds.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await env.DB.prepare(
    `SELECT b.id, b.reference, ${effectiveStatusSql('b')} AS status, b.expires_at, b.series_id, b.group_id, b.resource_id, b.starts_at, b.ends_at, b.total_amount_pence,
            r.name AS resource_name, u.full_name AS customer_name, u.email AS customer_email,
            u.phone_encrypted AS phone_encrypted, b.user_id, b.organisation_id, o.name AS organisation_name
     FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     LEFT JOIN organisations o ON o.id = b.organisation_id
     ${where} ORDER BY b.starts_at DESC LIMIT ${limit}`,
  )
    .bind(...binds)
    .all<{ phone_encrypted: string | null } & Record<string, unknown>>();

  const key = env.DATA_ENCRYPTION_KEY ?? '';
  const results = await Promise.all(
    rows.results.map(async ({ phone_encrypted, ...row }) => ({
      ...row,
      customer_phone: await decryptAtRest(phone_encrypted, key),
    })),
  );
  return json(results);
};
