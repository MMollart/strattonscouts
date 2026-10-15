import type { Env } from './http';
import { newId, now } from './http';
import { sendEmail, type EmailTemplate } from './email';
import { formatGBP } from '@shared/pricing';
import type { BookingStatus } from '@shared/types';

/**
 * Transition a booking to a new status, record a lifecycle event, and send the
 * relevant email. Returns false if the booking does not exist or the transition
 * is not permitted from its current status.
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
    `SELECT b.*, r.name AS resource_name, u.email AS email, u.full_name AS full_name
     FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     WHERE b.id = ?`,
  )
    .bind(args.bookingId)
    .first<any>();
  if (!booking) return { ok: false, code: 'not_found' };

  const current: BookingStatus = booking.status;
  // Allowed transitions for Release 1.
  const allowed: Record<string, BookingStatus[]> = {
    confirmed: ['pending_approval'],
    rejected: ['pending_approval'],
    cancelled: ['pending_approval', 'confirmed'],
  };
  if (!allowed[args.to].includes(current)) {
    return { ok: false, code: 'invalid_transition' };
  }

  const ts = now();
  const updates =
    args.to === 'confirmed'
      ? env.DB.prepare('UPDATE bookings SET status = ?, approved_by = ?, updated_at = ? WHERE id = ?').bind(args.to, args.actorId, ts, args.bookingId)
      : args.to === 'cancelled'
        ? env.DB.prepare('UPDATE bookings SET status = ?, cancelled_by = ?, updated_at = ? WHERE id = ?').bind(args.to, args.actorId, ts, args.bookingId)
        : env.DB.prepare('UPDATE bookings SET status = ?, approved_by = ?, updated_at = ? WHERE id = ?').bind(args.to, args.actorId, ts, args.bookingId);

  await env.DB.batch([
    updates,
    env.DB.prepare('INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      newId('bev'),
      args.bookingId,
      args.to === 'confirmed' ? 'approved' : args.to,
      args.actorId,
      null,
      ts,
    ),
  ]);

  const template: EmailTemplate =
    args.to === 'confirmed' ? 'booking_approved' : args.to === 'rejected' ? 'booking_rejected' : 'booking_cancelled';
  const start = new Date(booking.starts_at);
  await sendEmail(env, {
    to: booking.email,
    bookingId: args.bookingId,
    dedupeKey: `${args.bookingId}:${template}`,
    template,
    params: {
      customer_name: booking.full_name,
      booking_reference: booking.reference,
      resource_name: booking.resource_name,
      booking_date: start.toISOString().slice(0, 10),
      booking_start_time: start.toISOString().slice(11, 16),
      booking_end_time: new Date(booking.ends_at).toISOString().slice(11, 16),
      booking_cost: formatGBP(booking.total_amount_pence),
      booking_status: args.to,
    },
  });

  return { ok: true };
}
