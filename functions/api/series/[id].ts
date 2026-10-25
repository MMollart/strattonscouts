import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { getAuthUser } from '../../_lib/auth';
import { bookingAccess } from '../../_lib/booking-access';
import { effectiveStatusSql, resourceNamesSql } from '../../_lib/availability-sql';

// A recurring series and all its occurrences, for whoever may see its bookings.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const series = await env.DB.prepare(
    `SELECT s.*, r.name AS resource_name, u.full_name AS customer_name, o.name AS organisation_name
     FROM recurrence_series s JOIN resources r ON r.id = s.resource_id JOIN users u ON u.id = s.user_id
     LEFT JOIN organisations o ON o.id = s.organisation_id WHERE s.id = ?`,
  )
    .bind(String(params.id))
    .first<Record<string, unknown> & { user_id: string; organisation_id: string | null; excluded_dates: string }>();
  if (!series) return error('Series not found', 404);
  const access = await bookingAccess(env, user, series);
  if (!access.canView) return error('Not authorised', 403);

  const occurrences = await env.DB.prepare(
    `SELECT b.id, b.reference, b.resource_id, ${resourceNamesSql('b')} AS resource_name, b.starts_at, b.ends_at, ${effectiveStatusSql('b')} AS status, b.total_amount_pence
     FROM bookings b JOIN resources r ON r.id = b.resource_id WHERE b.series_id = ? ORDER BY b.starts_at`,
  )
    .bind(String(params.id))
    .all();
  return json({
    ...series,
    excluded_dates: JSON.parse(series.excluded_dates) as string[],
    can_manage: access.canManage,
    occurrences: occurrences.results,
  });
};
