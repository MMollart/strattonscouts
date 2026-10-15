import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { can, getAuthUser } from '../../_lib/auth';
import { createBookingSchema } from '@shared/validation';
import { createBookingAtomic } from '../../_lib/booking';
import { bookingTimeParams, sendEmail } from '../../_lib/email';
import { getMembershipRole } from '../../_lib/organisations';
import { formatGBP } from '@shared/pricing';
import { formatLondon } from '@shared/londonTime';
import { effectiveStatusSql } from '../../_lib/availability-sql';

// The signed-in customer's personal bookings plus bookings of every
// organisation they belong to.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const rows = await env.DB.prepare(
    `SELECT b.id, b.reference, b.resource_id, r.name AS resource_name, b.starts_at, b.ends_at,
            ${effectiveStatusSql('b')} AS status, b.expires_at, b.series_id, b.total_amount_pence, b.created_at, b.organisation_id, o.name AS organisation_name,
            u.full_name AS booked_by, (b.user_id = ?) AS is_mine
     FROM bookings b
     JOIN resources r ON r.id = b.resource_id
     JOIN users u ON u.id = b.user_id
     LEFT JOIN organisations o ON o.id = b.organisation_id
     WHERE b.user_id = ?
        OR b.organisation_id IN (SELECT organisation_id FROM organisation_memberships WHERE user_id = ?)
     ORDER BY b.starts_at DESC`,
  )
    .bind(user.id, user.id, user.id)
    .all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({ ...r, is_mine: !!r.is_mine })));
};

// Create a booking (customer, or admin on behalf of a customer), personally or
// on behalf of an organisation the customer belongs to.
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
    if (!can(user, 'bookings.create')) return error('Not authorised', 403);
    customerId = parsed.data.on_behalf_of_user_id;
  }

  // Organisation bookings: the customer must be a member (any role may book).
  const organisationId = parsed.data.organisation_id ?? null;
  if (organisationId && !(await getMembershipRole(env, organisationId, customerId))) {
    return error('You can only book on behalf of an organisation you belong to', 403);
  }

  // Overriding restrictions needs availability.manage and is recorded.
  if (parsed.data.override && !can(user, 'availability.manage')) {
    return error('Only authorised administrators can override booking restrictions', 403);
  }

  // Setting a booking's own hold period is an administrator action (FR04).
  if (parsed.data.provisional_expiry_hours && !can(user, 'bookings.manage')) {
    return error('Only administrators can set a provisional hold period', 403);
  }

  const result = await createBookingAtomic({
    env,
    userId: customerId,
    resourceId: parsed.data.resource_id,
    startsAt: parsed.data.starts_at,
    endsAt: parsed.data.ends_at,
    actorId: user.id,
    organisationId,
    override: parsed.data.override ?? null,
    provisional: parsed.data.provisional ?? false,
    provisionalExpiryHours: parsed.data.provisional ? (parsed.data.provisional_expiry_hours ?? null) : null,
  });

  if (!result.ok) {
    const status = result.code === 'conflict' ? 409 : result.code === 'resource_not_found' ? 404 : 400;
    return error(result.message, status, { code: result.code, violations: result.violations });
  }

  // Load details for the confirmation email.
  const details = await env.DB.prepare(
    `SELECT u.email, u.full_name, r.name AS resource_name, o.name AS organisation_name
     FROM bookings b JOIN users u ON u.id = b.user_id JOIN resources r ON r.id = b.resource_id
     LEFT JOIN organisations o ON o.id = b.organisation_id
     WHERE b.id = ?`,
  )
    .bind(result.bookingId)
    .first<{ email: string; full_name: string; resource_name: string; organisation_name: string | null }>();

  if (details) {
    const template =
      result.status === 'confirmed' ? 'booking_confirmation' : result.status === 'provisional' ? 'provisional_booking' : 'booking_request_received';
    await sendEmail(env, {
      to: details.email,
      bookingId: result.bookingId,
      dedupeKey: `${result.bookingId}:${template}`,
      template,
      params: {
        customer_name: details.full_name,
        organisation_name: details.organisation_name ?? '',
        booking_reference: result.reference,
        resource_name: details.resource_name,
        ...bookingTimeParams(result.startsAt, result.endsAt),
        booking_cost: formatGBP(result.totalPence),
        booking_status: result.status,
        expiry_date: result.expiresAt ? formatLondon(result.expiresAt) : '',
      },
    });
  }

  return json(
    { id: result.bookingId, reference: result.reference, status: result.status, total_amount_pence: result.totalPence, expires_at: result.expiresAt },
    201,
  );
};
