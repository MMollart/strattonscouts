import type { Env } from './http';
import type { AuthUser } from './auth';
import { activeBookingSql } from './availability-sql';
import { bookingAccess } from './booking-access';
import { loadHeldResources, planAmendments, type AmendProblem, type AmendTarget, type PlannedChange } from './amend';

/**
 * Customer booking amendments (FR12). A request is validated and priced like a
 * new booking for the proposed time, excluding the booking itself, so the
 * customer can move within or overlapping their own slot.
 */

export interface AmendableBooking extends AmendTarget {
  reference: string;
  status: string;
  active: number;
}

export async function loadAmendable(env: Env, bookingId: string): Promise<AmendableBooking | null> {
  const booking = await env.DB.prepare(
    `SELECT id, reference, user_id, organisation_id, resource_id, starts_at, ends_at, total_amount_pence, status,
            ${activeBookingSql('')} AS active
     FROM bookings WHERE id = ?`,
  )
    .bind(bookingId)
    .first<AmendableBooking>();
  if (!booking) return null;
  return { ...booking, resource_ids: (await loadHeldResources(env, [booking.id])).get(booking.id) ?? [booking.resource_id] };
}

/** The resources a change request asks for: resource_ids, or resource_id alone. */
export function requestedResources(input: { resource_id: string; resource_ids?: string[] }): string[] {
  return [...new Set([input.resource_id, ...(input.resource_ids ?? [])])];
}

export type AmendmentCheck =
  | { ok: true; booking: AmendableBooking; planned: PlannedChange }
  | { ok: false; status: number; message: string; code: string; problems?: AmendProblem[] };

/** Who may request a change, whether the booking can change, and the proposed price. */
export async function checkAmendment(
  env: Env,
  user: AuthUser,
  bookingId: string,
  change: { resourceIds: string[]; startsAt: string; endsAt: string },
): Promise<AmendmentCheck> {
  const booking = await loadAmendable(env, bookingId);
  if (!booking) return { ok: false, status: 404, message: 'Booking not found', code: 'not_found' };
  const access = await bookingAccess(env, user, booking);
  if (!access.canManage) return { ok: false, status: 403, message: 'Not authorised', code: 'forbidden' };
  if (!booking.active) return { ok: false, status: 400, message: 'Only an active booking can be changed', code: 'inactive' };
  if (Date.parse(booking.starts_at) <= Date.now()) {
    return { ok: false, status: 400, message: 'A booking that has started cannot be changed', code: 'started' };
  }
  const sameResources = [...(booking.resource_ids ?? [])].sort().join() === [...change.resourceIds].sort().join();
  if (sameResources && new Date(booking.starts_at).getTime() === new Date(change.startsAt).getTime()
      && new Date(booking.ends_at).getTime() === new Date(change.endsAt).getTime()) {
    return { ok: false, status: 400, message: 'The proposed booking is the same as the current one', code: 'unchanged' };
  }
  const plan = await planAmendments(env, [{ target: booking, ...change }]);
  if (!plan.ok) {
    return { ok: false, status: 409, message: plan.problems.map((p) => p.message).join(' '), code: plan.problems[0].reason, problems: plan.problems };
  }
  return { ok: true, booking, planned: plan.planned[0] };
}
