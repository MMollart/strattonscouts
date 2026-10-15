import type { Env } from '../../_lib/http';
import { json } from '../../_lib/http';
import { requirePermission } from '../../_lib/auth';
import { NOW_SQL, activeBookingSql, effectiveStatusSql } from '../../_lib/availability-sql';

// Admin dashboard summary metrics.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;

  const nowIso = new Date().toISOString();
  const upcoming = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM bookings WHERE ${activeBookingSql('')} AND starts_at >= ?`,
  )
    .bind(nowIso)
    .first<{ c: number }>();
  const confirmed = await env.DB.prepare("SELECT COUNT(*) AS c FROM bookings WHERE status = 'confirmed'").first<{ c: number }>();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS c FROM bookings WHERE status = 'pending_approval'").first<{ c: number }>();
  const provisional = await env.DB.prepare(`SELECT COUNT(*) AS c FROM bookings WHERE status = 'provisional' AND expires_at > ${NOW_SQL}`).first<{ c: number }>();
  const recent = await env.DB.prepare(
    `SELECT b.id, b.reference, r.name AS resource_name, ${effectiveStatusSql('b')} AS status, b.starts_at, b.created_at
     FROM bookings b JOIN resources r ON r.id = b.resource_id ORDER BY b.created_at DESC LIMIT 10`,
  ).all();

  return json({
    upcoming_bookings: upcoming?.c ?? 0,
    confirmed_bookings: confirmed?.c ?? 0,
    pending_approval: pending?.c ?? 0,
    provisional: provisional?.c ?? 0,
    recent_bookings: recent.results,
  });
};
