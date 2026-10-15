import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { can, getAuthUser } from '../../../_lib/auth';
import { bookingAccess } from '../../../_lib/booking-access';
import { transitionBooking } from '../../../_lib/lifecycle';

// Cancel a booking. The customer or an Organisation Manager may cancel an
// upcoming booking; administrators with bookings.manage may cancel any.
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);

  const booking = await env.DB.prepare('SELECT user_id, organisation_id, starts_at, status FROM bookings WHERE id = ?')
    .bind(id)
    .first<{ user_id: string; organisation_id: string | null; starts_at: string; status: string }>();
  if (!booking) return error('Booking not found', 404);

  const access = await bookingAccess(env, user, booking);
  if (!access.canManage) return error('Not authorised', 403);
  const admin = can(user, 'bookings.manage');

  // Customers may only cancel upcoming bookings.
  if (!admin && new Date(booking.starts_at).getTime() < Date.now()) {
    return error('Past bookings cannot be cancelled', 400);
  }

  const result = await transitionBooking(env, {
    bookingId: id,
    to: 'cancelled',
    actorId: user.id,
    actorIsAdmin: admin,
  });
  if (!result.ok) return error('Booking cannot be cancelled', 400, { code: result.code });
  return json({ ok: true });
};
