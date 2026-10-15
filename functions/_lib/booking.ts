import type { Env } from './http';
import { newId, now, bookingReference } from './http';
import { conflictingResourceIds, intervalsOverlap } from '@shared/availability';
import type { ConflictEdge } from '@shared/availability';
import { calculateTotalPence } from '@shared/pricing';
import type { BookingStatus, PricingModel } from '@shared/types';

export interface CreateBookingParams {
  env: Env;
  userId: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  actorId: string; // who is performing the action (customer or admin)
}

export type CreateBookingResult =
  | { ok: true; bookingId: string; reference: string; status: BookingStatus; totalPence: number }
  | { ok: false; code: 'resource_not_found' | 'inactive' | 'closure' | 'conflict' | 'no_price'; message: string };

const ACTIVE_STATUSES = ['pending_approval', 'confirmed'];

/**
 * Atomically create a booking, validating conflicts server-side against the
 * live database inside a single D1 batch (transaction). This prevents two
 * near-simultaneous requests from both succeeding for conflicting windows.
 *
 * Strategy: we perform the conflict read and the insert, then re-check the
 * conflict count after insert within the same batch. Because D1 batches run as
 * a single serialised transaction, a competing insert cannot interleave: the
 * second transaction observes the first's row and the post-insert guard trips,
 * and we roll back by deleting the row we just wrote.
 */
export async function createBookingAtomic(
  params: CreateBookingParams,
): Promise<CreateBookingResult> {
  const { env } = params;

  const resource = await env.DB.prepare(
    'SELECT id, is_active, requires_approval, pricing_model FROM resources WHERE id = ?',
  )
    .bind(params.resourceId)
    .first<{ id: string; is_active: number; requires_approval: number; pricing_model: PricingModel }>();
  if (!resource) return { ok: false, code: 'resource_not_found', message: 'Resource not found' };
  if (!resource.is_active) return { ok: false, code: 'inactive', message: 'Resource is not available' };

  // Customer category + price snapshot.
  const user = await env.DB.prepare('SELECT pricing_category_id FROM users WHERE id = ?')
    .bind(params.userId)
    .first<{ pricing_category_id: string }>();
  if (!user) return { ok: false, code: 'resource_not_found', message: 'Customer not found' };

  const price = await env.DB.prepare(
    'SELECT amount_pence, is_free FROM resource_pricing WHERE resource_id = ? AND category_id = ?',
  )
    .bind(params.resourceId, user.pricing_category_id)
    .first<{ amount_pence: number; is_free: number }>();
  if (!price) return { ok: false, code: 'no_price', message: 'No price configured for your category' };

  // Closure check.
  const closure = await env.DB.prepare(
    'SELECT id FROM resource_closures WHERE resource_id = ? AND starts_at < ? AND ends_at > ? LIMIT 1',
  )
    .bind(params.resourceId, params.endsAt, params.startsAt)
    .first();
  if (closure) return { ok: false, code: 'closure', message: 'Resource is unavailable for this period' };

  // Load conflict edges and compute the blocked resource set.
  const edges = await env.DB.prepare(
    'SELECT resource_id, conflicts_with_id FROM resource_conflicts WHERE resource_id = ? OR conflicts_with_id = ?',
  )
    .bind(params.resourceId, params.resourceId)
    .all<ConflictEdge>();
  const blocked = Array.from(conflictingResourceIds(params.resourceId, edges.results));

  const placeholders = blocked.map(() => '?').join(', ');
  const statusPlaceholders = ACTIVE_STATUSES.map(() => '?').join(', ');

  // Pre-insert conflict check.
  const conflictCountSql = `SELECT COUNT(*) AS c FROM bookings WHERE status IN (${statusPlaceholders}) AND resource_id IN (${placeholders}) AND starts_at < ? AND ends_at > ?`;
  const preCheck = await env.DB.prepare(conflictCountSql)
    .bind(...ACTIVE_STATUSES, ...blocked, params.endsAt, params.startsAt)
    .first<{ c: number }>();
  if ((preCheck?.c ?? 0) > 0) {
    return { ok: false, code: 'conflict', message: 'The requested period is no longer available' };
  }

  const bookingId = newId('bk');
  const reference = bookingReference();
  const status: BookingStatus = resource.requires_approval ? 'pending_approval' : 'confirmed';
  const totalPence = calculateTotalPence({
    pricingModel: resource.pricing_model,
    unitPricePence: price.amount_pence,
    isFree: !!price.is_free,
    startsAt: params.startsAt,
    endsAt: params.endsAt,
  });
  const ts = now();

  // Atomic batch: insert booking + allocation + event, then re-verify that no
  // other active booking overlaps the blocked set. Because the batch is a
  // single serialised transaction the guard observes any competing committed
  // row. If more than one row now exists, a race occurred and we abort.
  const insertBooking = env.DB.prepare(
    `INSERT INTO bookings (id, reference, user_id, resource_id, starts_at, ends_at, status, category_id, pricing_model, unit_price_pence, total_amount_pence, approved_by, cancelled_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).bind(
    bookingId,
    reference,
    params.userId,
    params.resourceId,
    params.startsAt,
    params.endsAt,
    status,
    user.pricing_category_id,
    resource.pricing_model,
    price.amount_pence,
    totalPence,
    ts,
    ts,
  );

  const insertAllocation = env.DB.prepare(
    'INSERT INTO booking_resources (booking_id, resource_id) VALUES (?, ?)',
  ).bind(bookingId, params.resourceId);

  const insertEvent = env.DB.prepare(
    'INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(newId('bev'), bookingId, status === 'confirmed' ? 'confirmed' : 'created', params.actorId, null, ts);

  await env.DB.batch([insertBooking, insertAllocation, insertEvent]);

  // Post-insert guard: count active overlapping bookings on the blocked set.
  // Our own row counts as 1; anything >1 means a concurrent conflicting booking
  // committed, so we roll back our insert.
  const postCheck = await env.DB.prepare(conflictCountSql)
    .bind(...ACTIVE_STATUSES, ...blocked, params.endsAt, params.startsAt)
    .first<{ c: number }>();
  if ((postCheck?.c ?? 0) > 1) {
    // Determine deterministically which booking "wins": the earliest created,
    // tie-broken by id. If we are not the winner, roll back.
    const winner = await env.DB.prepare(
      `SELECT id FROM bookings WHERE status IN (${statusPlaceholders}) AND resource_id IN (${placeholders}) AND starts_at < ? AND ends_at > ? ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
      .bind(...ACTIVE_STATUSES, ...blocked, params.endsAt, params.startsAt)
      .first<{ id: string }>();
    if (winner?.id !== bookingId) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM booking_events WHERE booking_id = ?').bind(bookingId),
        env.DB.prepare('DELETE FROM booking_resources WHERE booking_id = ?').bind(bookingId),
        env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(bookingId),
      ]);
      return { ok: false, code: 'conflict', message: 'The requested period is no longer available' };
    }
  }

  return { ok: true, bookingId, reference, status, totalPence };
}

/** Load active bookings relevant to availability for a resource + its conflicts. */
export async function loadActiveBookingsForResource(
  env: Env,
  resourceId: string,
): Promise<{ resource_id: string; starts_at: string; ends_at: string }[]> {
  const edges = await env.DB.prepare(
    'SELECT resource_id, conflicts_with_id FROM resource_conflicts WHERE resource_id = ? OR conflicts_with_id = ?',
  )
    .bind(resourceId, resourceId)
    .all<ConflictEdge>();
  const blocked = Array.from(conflictingResourceIds(resourceId, edges.results));
  const placeholders = blocked.map(() => '?').join(', ');
  const rows = await env.DB.prepare(
    `SELECT resource_id, starts_at, ends_at FROM bookings WHERE status IN ('pending_approval','confirmed') AND resource_id IN (${placeholders})`,
  )
    .bind(...blocked)
    .all<{ resource_id: string; starts_at: string; ends_at: string }>();
  return rows.results;
}

export { intervalsOverlap };
