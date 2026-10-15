import type { Env } from '../../../../_lib/http';
import { error, json } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { bookingTimeParams, sendEmail } from '../../../../_lib/email';
import { formatGBP } from '@shared/pricing';

// Admin: email the customer a payment reminder (FR06). Payment itself is out of scope.
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'bookings.manage');
  if (user instanceof Response) return user;
  const b = await env.DB.prepare(
    `SELECT b.id, b.reference, b.status, b.starts_at, b.ends_at, b.total_amount_pence, r.name AS resource_name,
            u.email, u.full_name, o.name AS organisation_name
     FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     LEFT JOIN organisations o ON o.id = b.organisation_id WHERE b.id = ?`,
  )
    .bind(String(params.id))
    .first<{ id: string; reference: string; status: string; starts_at: string; ends_at: string; total_amount_pence: number; resource_name: string; email: string; full_name: string; organisation_name: string | null }>();
  if (!b) return error('Booking not found', 404);
  if (b.status !== 'confirmed') return error('Payment reminders can only be sent for confirmed bookings', 400);
  if (b.total_amount_pence === 0) return error('This booking is free of charge', 400);
  const result = await sendEmail(env, {
    to: b.email,
    bookingId: b.id,
    template: 'payment_reminder',
    params: {
      customer_name: b.full_name,
      organisation_name: b.organisation_name ?? '',
      booking_reference: b.reference,
      resource_name: b.resource_name,
      ...bookingTimeParams(b.starts_at, b.ends_at),
      booking_cost: formatGBP(b.total_amount_pence),
      booking_status: b.status,
    },
  });
  if (result.status === 'disabled') return error('The payment reminder email is turned off in Email templates', 400, { code: 'disabled' });
  return json({ ok: result.status === 'sent', status: result.status });
};
