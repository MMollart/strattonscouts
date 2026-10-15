import type { Env } from '../../../../_lib/http';
import { error, json, newId, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { NOW_SQL, canonicalIso } from '../../../../_lib/availability-sql';
import { bookingExpirySchema } from '@shared/validation';

/**
 * Admin: change when a provisional booking's hold lapses (FR04). Only a hold
 * that is still live can be changed, and the new expiry must be in the future
 * and no later than the booking's start, so an expired hold cannot be revived
 * over a booking someone else may have made since.
 */
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'bookings.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, bookingExpirySchema);
  if (input instanceof Response) return input;
  const id = String(params.id);
  const expiresAt = canonicalIso(input.expires_at);
  if (Date.parse(expiresAt) <= Date.now()) return error('The new expiry must be in the future', 400);

  const ts = now();
  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE bookings SET expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'provisional' AND expires_at > ${NOW_SQL} AND starts_at >= ?`,
    ).bind(expiresAt, ts, id, expiresAt),
    env.DB.prepare(
      `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at)
       SELECT ?, ?, 'expiry_changed', ?, ?, ? WHERE changes() = 1`,
    ).bind(newId('bev'), id, user.id, JSON.stringify({ expires_at: expiresAt }), ts),
  ]);
  if (updated.meta.changes !== 1) {
    const b = await env.DB.prepare(`SELECT status, starts_at, expires_at > ${NOW_SQL} AS live FROM bookings WHERE id = ?`)
      .bind(id)
      .first<{ status: string; starts_at: string; live: number }>();
    if (!b) return error('Booking not found', 404);
    if (b.status !== 'provisional' || !b.live) return error('Only a live provisional booking can have its expiry changed', 409);
    return error('The hold cannot run past the start of the booking', 400);
  }
  return json({ ok: true, expires_at: expiresAt });
};
