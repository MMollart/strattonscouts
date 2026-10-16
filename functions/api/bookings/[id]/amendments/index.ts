import type { Env } from '../../../../_lib/http';
import { error, json, newId, now } from '../../../../_lib/http';
import { getAuthUser } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { bookingAccess } from '../../../../_lib/booking-access';
import { checkAmendment } from '../../../../_lib/amendments';
import { amendmentRequestSchema } from '@shared/validation';

// Amendment history for a booking, for anyone who can view it.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const booking = await env.DB.prepare('SELECT user_id, organisation_id FROM bookings WHERE id = ?')
    .bind(String(params.id))
    .first<{ user_id: string; organisation_id: string | null }>();
  if (!booking) return error('Booking not found', 404);
  if (!(await bookingAccess(env, user, booking)).canView) return error('Not authorised', 403);
  const rows = await env.DB.prepare(
    `SELECT a.id, a.status, a.from_resource_id, fr.name AS from_resource_name, a.from_starts_at, a.from_ends_at, a.from_total_pence,
            a.to_resource_id, tr.name AS to_resource_name, a.to_starts_at, a.to_ends_at, a.to_total_pence, a.customer_note,
            a.decision_note, a.decided_at, a.created_at, u.full_name AS requested_by_name
     FROM booking_amendments a JOIN resources fr ON fr.id = a.from_resource_id JOIN resources tr ON tr.id = a.to_resource_id
     JOIN users u ON u.id = a.requested_by
     WHERE a.booking_id = ? ORDER BY a.created_at DESC`,
  )
    .bind(String(params.id))
    .all();
  return json(rows.results);
};

/**
 * Request a change (FR12 §11.3). Every customer-requested change needs
 * administrator approval; the original booking stays reserved meanwhile.
 */
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const input = await parseBody(request, amendmentRequestSchema);
  if (input instanceof Response) return input;
  const check = await checkAmendment(env, user, String(params.id), { resourceId: input.resource_id, startsAt: input.starts_at, endsAt: input.ends_at });
  if (!check.ok) return error(check.message, check.status, { code: check.code, problems: check.problems });
  const { booking, planned } = check;

  const id = newId('amd');
  const ts = now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO booking_amendments (id, booking_id, requested_by, status, from_resource_id, from_starts_at, from_ends_at, from_total_pence,
                                         to_resource_id, to_starts_at, to_ends_at, to_total_pence, price_breakdown, customer_note, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, booking.id, user.id, booking.resource_id, booking.starts_at, booking.ends_at, booking.total_amount_pence,
        planned.resourceId, planned.startsAt, planned.endsAt, planned.price.total_pence, JSON.stringify(planned.price), input.note ?? null, ts, ts,
      ),
      env.DB.prepare(
        `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at) VALUES (?, ?, 'amendment_requested', ?, ?, ?)`,
      ).bind(newId('bev'), booking.id, user.id, JSON.stringify({
          amendment_id: id,
          from: { resource_id: booking.resource_id, starts_at: booking.starts_at, ends_at: booking.ends_at, total_amount_pence: booking.total_amount_pence },
          to: { resource_id: planned.resourceId, starts_at: planned.startsAt, ends_at: planned.endsAt, total_amount_pence: planned.price.total_pence },
          note: input.note ?? null,
        }), ts),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return error('This booking already has a change request waiting for approval', 409, { code: 'pending_exists' });
    throw e;
  }
  return json({ id, status: 'pending', to_total_pence: planned.price.total_pence, difference_pence: planned.price.total_pence - booking.total_amount_pence }, 201);
};
