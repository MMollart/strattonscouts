import type { Env } from './http';
import { newId, now, bookingReference } from './http';
import {
  CONFLICTING_BOOKING_SQL,
  OVERLAPPING_CLOSURE_SQL,
  canonicalIso,
  closureBinds,
} from './availability-sql';
import { calculateTotalPence } from '@shared/pricing';
import type { BookingStatus, PricingModel } from '@shared/types';

export interface CreateBookingParams {
  env: Env;
  userId: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  actorId: string; // who is performing the action (customer or admin)
  /** Book on behalf of this organisation; the caller has checked membership. */
  organisationId?: string | null;
}

export type CreateBookingResult =
  | {
      ok: true;
      bookingId: string;
      reference: string;
      status: BookingStatus;
      totalPence: number;
      startsAt: string;
      endsAt: string;
    }
  | { ok: false; code: 'resource_not_found' | 'inactive' | 'closure' | 'conflict' | 'no_price'; message: string };

/**
 * Atomically create a booking.
 *
 * The booking row is written by a single `INSERT ... SELECT ... WHERE NOT
 * EXISTS (conflict) AND NOT EXISTS (closure)` statement. D1 executes each
 * statement atomically against a single SQLite writer, so the availability
 * check and the write cannot be interleaved with a competing request: of two
 * near-simultaneous conflicting submissions, exactly one inserts a row and the
 * other inserts nothing. The allocation and event rows are inserted in the same
 * batch (transaction) and only if the booking row exists.
 */
export async function createBookingAtomic(
  params: CreateBookingParams,
): Promise<CreateBookingResult> {
  const { env } = params;
  const startsAt = canonicalIso(params.startsAt);
  const endsAt = canonicalIso(params.endsAt);

  const resource = await env.DB.prepare(
    'SELECT id, is_active, requires_approval, pricing_model FROM resources WHERE id = ?',
  )
    .bind(params.resourceId)
    .first<{ id: string; is_active: number; requires_approval: number; pricing_model: PricingModel }>();
  if (!resource) return { ok: false, code: 'resource_not_found', message: 'Resource not found' };
  if (!resource.is_active) return { ok: false, code: 'inactive', message: 'Resource is not available' };

  // Customer category + price snapshot. Organisation bookings use the
  // organisation's category.
  const user = params.organisationId
    ? await env.DB.prepare('SELECT pricing_category_id FROM organisations WHERE id = ?')
        .bind(params.organisationId)
        .first<{ pricing_category_id: string }>()
    : await env.DB.prepare('SELECT pricing_category_id FROM users WHERE id = ?')
        .bind(params.userId)
        .first<{ pricing_category_id: string }>();
  if (!user) return { ok: false, code: 'resource_not_found', message: params.organisationId ? 'Organisation not found' : 'Customer not found' };

  const price = await env.DB.prepare(
    'SELECT amount_pence, is_free FROM resource_pricing WHERE resource_id = ? AND category_id = ?',
  )
    .bind(params.resourceId, user.pricing_category_id)
    .first<{ amount_pence: number; is_free: number }>();
  if (!price) return { ok: false, code: 'no_price', message: 'No price configured for your category' };

  // Closures are checked first so the customer gets the more specific message;
  // the atomic insert below re-checks both conditions regardless.
  const closure = await env.DB.prepare(OVERLAPPING_CLOSURE_SQL)
    .bind(...closureBinds(params.resourceId), endsAt, startsAt)
    .first();
  if (closure) return { ok: false, code: 'closure', message: 'Resource is unavailable for this period' };

  const bookingId = newId('bk');
  const reference = bookingReference();
  const status: BookingStatus = resource.requires_approval ? 'pending_approval' : 'confirmed';
  const totalPence = calculateTotalPence({
    pricingModel: resource.pricing_model,
    unitPricePence: price.amount_pence,
    isFree: !!price.is_free,
    startsAt,
    endsAt,
  });
  const ts = now();

  const insertBooking = env.DB.prepare(
    `INSERT INTO bookings (id, reference, user_id, resource_id, starts_at, ends_at, status, category_id, pricing_model, unit_price_pence, total_amount_pence, approved_by, cancelled_by, created_at, updated_at, organisation_id, created_by)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?
     WHERE NOT EXISTS (${CONFLICTING_BOOKING_SQL})
       AND NOT EXISTS (${OVERLAPPING_CLOSURE_SQL})`,
  ).bind(
    bookingId,
    reference,
    params.userId,
    params.resourceId,
    startsAt,
    endsAt,
    status,
    user.pricing_category_id,
    resource.pricing_model,
    price.amount_pence,
    totalPence,
    ts,
    ts,
    params.organisationId ?? null,
    params.actorId,
    params.resourceId,
    params.resourceId,
    params.resourceId,
    endsAt,
    startsAt,
    bookingId,
    ...closureBinds(params.resourceId),
    endsAt,
    startsAt,
  );

  const insertAllocation = env.DB.prepare(
    'INSERT INTO booking_resources (booking_id, resource_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)',
  ).bind(bookingId, params.resourceId, bookingId);

  const insertEvent = env.DB.prepare(
    `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at)
     SELECT ?, ?, ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)`,
  ).bind(newId('bev'), bookingId, status === 'confirmed' ? 'confirmed' : 'created', params.actorId, ts, bookingId);

  const [bookingResult] = await env.DB.batch([insertBooking, insertAllocation, insertEvent]);
  if (bookingResult.meta.changes !== 1) {
    return { ok: false, code: 'conflict', message: 'The requested period is no longer available' };
  }

  return { ok: true, bookingId, reference, status, totalPence, startsAt, endsAt };
}
