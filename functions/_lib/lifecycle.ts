import type { Env } from './http';
import { newId, now } from './http';
import { bookingTimeParams, sendEmail, type EmailTemplate } from './email';
import { CONFLICTING_BOOKING_SQL, OVERLAPPING_CLOSURE_SQL, closureBinds } from './availability-sql';
import { formatGBP } from '@shared/pricing';
import type { BookingStatus } from '@shared/types';

interface BookingForTransition {
  id: string;
  reference: string;
  resource_id: string;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  total_amount_pence: number;
  resource_name: string;
  email: string;
  full_name: string;
}

// Allowed transitions for Release 1: target status -> permitted current statuses.
const ALLOWED_FROM: Record<'confirmed' | 'rejected' | 'cancelled', BookingStatus[]> = {
  confirmed: ['pending_approval'],
  rejected: ['pending_approval'],
  cancelled: ['pending_approval', 'confirmed'],
};

/**
 * Transition a booking to a new status, record a lifecycle event, and send the
 * relevant email. Returns false if the booking does not exist or the transition
 * is not permitted from its current status. Approval revalidates the booking
 * against conflicts and closures and fails with code 'conflict' or 'closure'.
 */
export async function transitionBooking(
  env: Env,
  args: {
    bookingId: string;
    to: Extract<BookingStatus, 'confirmed' | 'rejected' | 'cancelled'>;
    actorId: string;
    actorIsAdmin: boolean;
  },
): Promise<{ ok: boolean; code?: string }> {
  const booking = await env.DB.prepare(
    `SELECT b.id, b.reference, b.resource_id, b.starts_at, b.ends_at, b.status, b.total_amount_pence,
            r.name AS resource_name, u.email AS email, u.full_name AS full_name
     FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     WHERE b.id = ?`,
  )
    .bind(args.bookingId)
    .first<BookingForTransition>();
  if (!booking) return { ok: false, code: 'not_found' };

  const allowedFrom = ALLOWED_FROM[args.to];
  if (!allowedFrom.includes(booking.status)) {
    return { ok: false, code: 'invalid_transition' };
  }

  const ts = now();
  const statusPlaceholders = allowedFrom.map(() => '?').join(', ');
  const actorColumn = args.to === 'cancelled' ? 'cancelled_by' : 'approved_by';
  let update = `UPDATE bookings SET status = ?, ${actorColumn} = ?, updated_at = ?
                WHERE id = ? AND status IN (${statusPlaceholders})`;
  const binds: unknown[] = [args.to, args.actorId, ts, args.bookingId, ...allowedFrom];

  if (args.to === 'confirmed') {
    // Revalidate on approval: the period must still be free of other active
    // bookings (e.g. after a conflict-matrix change) and of closures.
    const closure = await env.DB.prepare(OVERLAPPING_CLOSURE_SQL)
      .bind(...closureBinds(booking.resource_id), booking.ends_at, booking.starts_at)
      .first();
    if (closure) return { ok: false, code: 'closure' };
    update += ` AND NOT EXISTS (${CONFLICTING_BOOKING_SQL}) AND NOT EXISTS (${OVERLAPPING_CLOSURE_SQL})`;
    binds.push(
      booking.resource_id,
      booking.resource_id,
      booking.resource_id,
      booking.ends_at,
      booking.starts_at,
      booking.id,
      ...closureBinds(booking.resource_id),
      booking.ends_at,
      booking.starts_at,
    );
  }

  // The status guard in the UPDATE makes the transition atomic: if another
  // request changed the booking first, nothing is written and we report it.
  const [updated] = await env.DB.batch([
    env.DB.prepare(update).bind(...binds),
    env.DB.prepare(
      `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at)
       SELECT ?, ?, ?, ?, NULL, ? WHERE changes() = 1`,
    ).bind(newId('bev'), args.bookingId, args.to === 'confirmed' ? 'approved' : args.to, args.actorId, ts),
  ]);
  if (updated.meta.changes !== 1) {
    const latest = await env.DB.prepare('SELECT status FROM bookings WHERE id = ?')
      .bind(args.bookingId)
      .first<{ status: BookingStatus }>();
    return { ok: false, code: latest?.status === booking.status ? 'conflict' : 'invalid_transition' };
  }

  const template: EmailTemplate =
    args.to === 'confirmed' ? 'booking_approved' : args.to === 'rejected' ? 'booking_rejected' : 'booking_cancelled';
  await sendEmail(env, {
    to: booking.email,
    bookingId: args.bookingId,
    dedupeKey: `${args.bookingId}:${template}`,
    template,
    params: {
      customer_name: booking.full_name,
      booking_reference: booking.reference,
      resource_name: booking.resource_name,
      ...bookingTimeParams(booking.starts_at, booking.ends_at),
      booking_cost: formatGBP(booking.total_amount_pence),
      booking_status: args.to,
    },
  });

  return { ok: true };
}
