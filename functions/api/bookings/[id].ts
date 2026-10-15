import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { getAuthUser, isAdmin } from '../../_lib/auth';

// View a single booking. Customers may only view their own; admins any.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);

  const booking = await env.DB.prepare(
    `SELECT b.*, r.name AS resource_name, u.full_name AS customer_name, u.email AS customer_email
     FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     WHERE b.id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!booking) return error('Booking not found', 404);

  if (booking.user_id !== user.id && !isAdmin(user)) {
    return error('Not authorised', 403);
  }

  // Non-admins must not see other customers' contact info (they only see own).
  if (!isAdmin(user)) {
    delete booking.customer_email;
  }

  return json(booking);
};
