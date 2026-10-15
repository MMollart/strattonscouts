import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { getAuthUser, isAdmin } from '../../_lib/auth';
import { createBookingSchema } from '@shared/validation';
import { createBookingAtomic } from '../../_lib/booking';
import { bookingTimeParams, sendEmail } from '../../_lib/email';
import { formatGBP } from '@shared/pricing';

// List the authenticated customer's own bookings.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const rows = await env.DB.prepare(
    `SELECT b.id, b.reference, b.resource_id, r.name AS resource_name, b.starts_at, b.ends_at,
            b.status, b.total_amount_pence, b.created_at
     FROM bookings b JOIN resources r ON r.id = b.resource_id
     WHERE b.user_id = ? ORDER BY b.starts_at DESC`,
  )
    .bind(user.id)
    .all();
  return json(rows.results);
};

// Create a booking (customer, or admin on behalf of a customer).
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = createBookingSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());

  // Determine the customer the booking is for.
  let customerId = user.id;
  if (parsed.data.on_behalf_of_user_id) {
    if (!isAdmin(user)) return error('Not authorised', 403);
    customerId = parsed.data.on_behalf_of_user_id;
  }

  const result = await createBookingAtomic({
    env,
    userId: customerId,
    resourceId: parsed.data.resource_id,
    startsAt: parsed.data.starts_at,
    endsAt: parsed.data.ends_at,
    actorId: user.id,
  });

  if (!result.ok) {
    const status = result.code === 'conflict' ? 409 : result.code === 'resource_not_found' ? 404 : 400;
    return error(result.message, status, { code: result.code });
  }

  // Load details for the confirmation email.
  const details = await env.DB.prepare(
    `SELECT u.email, u.full_name, r.name AS resource_name
     FROM bookings b JOIN users u ON u.id = b.user_id JOIN resources r ON r.id = b.resource_id
     WHERE b.id = ?`,
  )
    .bind(result.bookingId)
    .first<{ email: string; full_name: string; resource_name: string }>();

  if (details) {
    await sendEmail(env, {
      to: details.email,
      bookingId: result.bookingId,
      dedupeKey: `${result.bookingId}:${result.status === 'confirmed' ? 'booking_confirmation' : 'booking_request_received'}`,
      template: result.status === 'confirmed' ? 'booking_confirmation' : 'booking_request_received',
      params: {
        customer_name: details.full_name,
        booking_reference: result.reference,
        resource_name: details.resource_name,
        ...bookingTimeParams(result.startsAt, result.endsAt),
        booking_cost: formatGBP(result.totalPence),
        booking_status: result.status,
      },
    });
  }

  return json(
    { id: result.bookingId, reference: result.reference, status: result.status, total_amount_pence: result.totalPence },
    201,
  );
};
