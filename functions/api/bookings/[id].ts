import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { getAuthUser } from '../../_lib/auth';
import { bookingAccess } from '../../_lib/booking-access';

// View a single booking: its customer, members of its organisation, or admins.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);

  const booking = await env.DB.prepare(
    `SELECT b.*, r.name AS resource_name, u.full_name AS customer_name, u.email AS customer_email,
            o.name AS organisation_name
     FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     LEFT JOIN organisations o ON o.id = b.organisation_id
     WHERE b.id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown> & { user_id: string; organisation_id: string | null }>();
  if (!booking) return error('Booking not found', 404);

  const access = await bookingAccess(env, user, booking);
  if (!access.canView) return error('Not authorised', 403);

  // Contact details and internal records are only shown to administrators.
  if (!access.isAdminView) delete booking.customer_email;
  const overrides = access.isAdminView
    ? (
        await env.DB.prepare(
          `SELECT o.id, o.rule, o.detail, o.reason, o.created_at, u.full_name AS admin_name
           FROM availability_overrides o LEFT JOIN users u ON u.id = o.admin_id WHERE o.booking_id = ? ORDER BY o.created_at`,
        )
          .bind(id)
          .all()
      ).results
    : undefined;

  return json({ ...booking, can_manage: access.canManage, ...(overrides ? { overrides } : {}) });
};
