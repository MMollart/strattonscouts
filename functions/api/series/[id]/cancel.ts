import type { Env } from '../../../_lib/http';
import { error, json, now } from '../../../_lib/http';
import { can, getAuthUser } from '../../../_lib/auth';
import { bookingAccess } from '../../../_lib/booking-access';
import { parseBody } from '../../../_lib/request';
import { activeBookingSql } from '../../../_lib/availability-sql';
import { bookingTimeParams, sendEmail } from '../../../_lib/email';
import { seriesDateText } from '../../../_lib/recurring';
import { seriesCancelSchema } from '@shared/validation';
import { formatLondon } from '@shared/londonTime';

/**
 * Cancel a whole series, or one occurrence and every later one (FR05 §6.5).
 * Single occurrences are cancelled with the normal booking cancel. Customers
 * (and organisation managers) may cancel upcoming occurrences; administrators
 * with bookings.manage may cancel any. Past occurrences stay as history.
 */
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const input = await parseBody(request, seriesCancelSchema);
  if (input instanceof Response) return input;
  const id = String(params.id);

  const series = await env.DB.prepare(
    `SELECT s.id, s.reference, s.user_id, s.organisation_id, r.name AS resource_name, u.email, u.full_name
     FROM recurrence_series s JOIN resources r ON r.id = s.resource_id JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  )
    .bind(id)
    .first<{ id: string; reference: string; user_id: string; organisation_id: string | null; resource_name: string; email: string; full_name: string }>();
  if (!series) return error('Series not found', 404);
  const access = await bookingAccess(env, user, series);
  if (!access.canManage) return error('Not authorised', 403);
  const admin = can(user, 'bookings.manage');

  let from = admin ? '' : now();
  if (input.scope === 'future') {
    if (!input.from_booking_id) return error('Choose the first occurrence to cancel', 400);
    const b = await env.DB.prepare('SELECT starts_at FROM bookings WHERE id = ? AND series_id = ?')
      .bind(input.from_booking_id, id)
      .first<{ starts_at: string }>();
    if (!b) return error('That booking is not part of this series', 400);
    if (b.starts_at > from) from = b.starts_at;
  }

  const ts = now();
  const targetSql = `series_id = ? AND starts_at >= ? AND ${activeBookingSql('')}`;
  const [targets] = await env.DB.batch<{ id: string; starts_at: string; ends_at: string }>([
    env.DB.prepare(`SELECT id, starts_at, ends_at FROM bookings WHERE ${targetSql} ORDER BY starts_at`).bind(id, from),
    env.DB.prepare(
      `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at)
       SELECT 'bev_' || lower(hex(randomblob(16))), id, 'cancelled', ?, ?, ? FROM bookings WHERE ${targetSql}`,
    ).bind(user.id, JSON.stringify({ series_id: id, scope: input.scope }), ts, id, from),
    env.DB.prepare(
      `UPDATE booking_amendments SET status = 'withdrawn', decided_by = ?, decided_at = ?, updated_at = ?
       WHERE status = 'pending' AND booking_id IN (SELECT id FROM bookings WHERE ${targetSql})`,
    ).bind(user.id, ts, ts, id, from),
    env.DB.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_by = ?, updated_at = ? WHERE ${targetSql}`).bind(user.id, ts, id, from),
    env.DB.prepare(
      `UPDATE recurrence_series SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND NOT EXISTS (SELECT 1 FROM bookings WHERE series_id = ? AND ${activeBookingSql('')})`,
    ).bind(ts, id, id),
  ]);
  const cancelled = targets.results;
  if (!cancelled.length) return error('There are no occurrences left to cancel', 400);

  const day = { dateStyle: 'medium' } as const;
  await sendEmail(env, {
    to: series.email,
    dedupeKey: `${id}:booking_cancelled:${cancelled[0].id}`,
    template: 'booking_cancelled',
    params: {
      customer_name: series.full_name,
      booking_reference: series.reference,
      resource_name: series.resource_name,
      ...bookingTimeParams(cancelled[0].starts_at, cancelled[0].ends_at),
      booking_date: seriesDateText(cancelled.length, formatLondon(cancelled[0].starts_at, day), formatLondon(cancelled[cancelled.length - 1].starts_at, day)),
      booking_status: 'cancelled',
    },
  });
  return json({ ok: true, cancelled: cancelled.length });
};
