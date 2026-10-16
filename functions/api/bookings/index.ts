import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { can, getAuthUser } from '../../_lib/auth';
import { createBookingSchema } from '@shared/validation';
import { createBookingAtomic } from '../../_lib/booking';
import { createBookingGroup } from '../../_lib/booking-group';
import { checkAcceptance, requiredAgreements, signatureDraft } from '../../_lib/agreements';
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
            u.full_name AS booked_by, (b.user_id = ?) AS is_mine,
            EXISTS (SELECT 1 FROM booking_amendments a WHERE a.booking_id = b.id AND a.status = 'pending') AS has_pending_amendment
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
  return json(rows.results.map((r) => ({ ...r, is_mine: !!r.is_mine, has_pending_amendment: !!r.has_pending_amendment })));
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

  const extra = (parsed.data.additional_resource_ids ?? []).filter((id) => id !== parsed.data.resource_id);

  // Agreements for every resource booked must be accepted explicitly (FR20).
  const required = await requiredAgreements(env, [parsed.data.resource_id, ...extra]);
  const accepted = checkAcceptance(required, parsed.data.agreements);
  if (!accepted.ok) return accepted.response;
  const acceptance = accepted.accepted.length
    ? { signature: signatureDraft(parsed.data.agreements!, user.id, customerId), agreements: accepted.accepted }
    : null;

  if (extra.length) {
    return createGroup(env, {
      userId: customerId,
      resourceIds: [parsed.data.resource_id, ...extra],
      startsAt: parsed.data.starts_at,
      endsAt: parsed.data.ends_at,
      actorId: user.id,
      organisationId,
      override: parsed.data.override ?? null,
      provisional: parsed.data.provisional ?? false,
      provisionalExpiryHours: parsed.data.provisional ? (parsed.data.provisional_expiry_hours ?? null) : null,
      acceptance,
    });
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
    acceptance,
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

const TEMPLATE_FOR_STATUS = { confirmed: 'booking_confirmation', provisional: 'provisional_booking', pending_approval: 'booking_request_received' } as const;

/**
 * Several resources for the same time in one request. Each resource gets its
 * own booking (and its own approval where required); the customer gets one
 * email per outcome, naming every resource it covers.
 */
async function createGroup(env: Env, params: Omit<Parameters<typeof createBookingGroup>[0], 'env'>): Promise<Response> {
  const result = await createBookingGroup({ ...params, env });
  if (!result.ok) {
    const status = result.code === 'conflict' ? 409 : result.code === 'resource_not_found' ? 404 : 400;
    return error(result.message, status, { code: result.code, violations: result.violations, resource_id: result.resourceId });
  }

  const details = await env.DB.prepare(
    `SELECT u.email, u.full_name, o.name AS organisation_name FROM users u LEFT JOIN organisations o ON o.id = ? WHERE u.id = ?`,
  )
    .bind(params.organisationId ?? null, params.userId)
    .first<{ email: string; full_name: string; organisation_name: string | null }>();
  const names = await env.DB.prepare(`SELECT id, name FROM resources WHERE id IN (${result.bookings.map(() => '?').join(', ')})`)
    .bind(...result.bookings.map((b) => b.resourceId))
    .all<{ id: string; name: string }>();
  const nameOf = Object.fromEntries(names.results.map((r) => [r.id, r.name]));

  if (details) {
    for (const [status, template] of Object.entries(TEMPLATE_FOR_STATUS)) {
      const these = result.bookings.filter((b) => b.status === status);
      if (!these.length) continue;
      await sendEmail(env, {
        to: details.email,
        bookingId: these[0].bookingId,
        dedupeKey: `${result.groupId}:${template}`,
        template,
        params: {
          customer_name: details.full_name,
          organisation_name: details.organisation_name ?? '',
          booking_reference: these.map((b) => b.reference).join(', '),
          resource_name: these.map((b) => nameOf[b.resourceId]).join(', '),
          ...bookingTimeParams(result.startsAt, result.endsAt),
          booking_cost: formatGBP(these.reduce((sum, b) => sum + b.totalPence, 0)),
          booking_status: status,
          expiry_date: these[0].expiresAt ? formatLondon(these[0].expiresAt) : '',
        },
      });
    }
  }

  return json(
    {
      id: result.bookings[0].bookingId,
      group_id: result.groupId,
      total_amount_pence: result.totalPence,
      bookings: result.bookings.map((b) => ({ id: b.bookingId, reference: b.reference, resource_id: b.resourceId, resource_name: nameOf[b.resourceId], status: b.status, total_amount_pence: b.totalPence, expires_at: b.expiresAt })),
    },
    201,
  );
}
