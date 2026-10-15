import type { Env } from './http';
import { newId, now } from './http';
import { getIntSetting } from './settings';
import { bookingTimeParams, sendEmail } from './email';
import { formatGBP } from '@shared/pricing';

/**
 * Provisional bookings (FR04). A provisional booking holds its resource until
 * `expires_at`; availability SQL treats it as active only until then (see
 * activeBookingSql), so release does not wait for the scheduler.
 */

/** Hours a provisional booking is held: the resource's own period, else the global setting. */
export async function provisionalHoldHours(env: Env, resourceHours: number | null | undefined): Promise<number> {
  if (resourceHours && resourceHours > 0) return resourceHours;
  return getIntSetting(env, 'provisional_expiry_hours', 48);
}

/**
 * Expiry timestamp for a hold placed at `nowMs`. A hold never outlasts the
 * start of the booking itself: an unconfirmed booking must not still be
 * provisional once it has begun.
 */
export function provisionalExpiry(nowMs: number, hours: number, startsAt: string): string {
  return new Date(Math.min(nowMs + hours * 3_600_000, Date.parse(startsAt))).toISOString();
}

interface ExpiringBooking {
  id: string;
  reference: string;
  starts_at: string;
  ends_at: string;
  total_amount_pence: number;
  resource_name: string;
  email: string;
  full_name: string;
}

/**
 * Mark every provisional booking past its expiry as expired, record the event
 * and email the customer. Idempotent and safe to run concurrently: each
 * booking is moved by a status-guarded UPDATE, the event is written only when
 * that UPDATE changed the row, and the email uses a per-booking dedupe key.
 * Returns the number of bookings this run expired.
 */
export async function expireProvisionalBookings(env: Env, opts: { nowIso?: string; limit?: number } = {}): Promise<number> {
  const nowIso = opts.nowIso ?? now();
  const due = await env.DB.prepare(
    `SELECT b.id, b.reference, b.starts_at, b.ends_at, b.total_amount_pence, r.name AS resource_name, u.email, u.full_name
     FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     WHERE b.status = 'provisional' AND b.expires_at <= ?
     ORDER BY b.expires_at LIMIT ?`,
  )
    .bind(nowIso, opts.limit ?? 200)
    .all<ExpiringBooking>();

  let expired = 0;
  for (const b of due.results) {
    const [updated] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE bookings SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'provisional' AND expires_at <= ?`,
      ).bind(nowIso, b.id, nowIso),
      env.DB.prepare(
        `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at)
         SELECT ?, ?, 'expired', NULL, NULL, ? WHERE changes() = 1`,
      ).bind(newId('bev'), b.id, nowIso),
    ]);
    if (updated.meta.changes !== 1) continue;
    expired++;
    await sendEmail(env, {
      to: b.email,
      bookingId: b.id,
      dedupeKey: `${b.id}:provisional_expired`,
      template: 'provisional_expired',
      params: {
        customer_name: b.full_name,
        booking_reference: b.reference,
        resource_name: b.resource_name,
        ...bookingTimeParams(b.starts_at, b.ends_at),
        booking_cost: formatGBP(b.total_amount_pence),
        booking_status: 'expired',
      },
    });
  }
  return expired;
}
