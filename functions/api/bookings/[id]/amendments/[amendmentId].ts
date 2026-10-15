import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { getAuthUser } from '../../../../_lib/auth';
import { bookingAccess } from '../../../../_lib/booking-access';

// Withdraw a pending change request (the customer or an organisation manager).
export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const booking = await env.DB.prepare('SELECT user_id, organisation_id FROM bookings WHERE id = ?')
    .bind(String(params.id))
    .first<{ user_id: string; organisation_id: string | null }>();
  if (!booking) return error('Booking not found', 404);
  if (!(await bookingAccess(env, user, booking)).canManage) return error('Not authorised', 403);
  const res = await env.DB.prepare(
    `UPDATE booking_amendments SET status = 'withdrawn', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND booking_id = ? AND status = 'pending'`,
  )
    .bind(user.id, now(), now(), String(params.amendmentId), String(params.id))
    .run();
  if (res.meta.changes !== 1) return error('There is no pending request to withdraw', 409);
  return json({ ok: true });
};
