import type { Env } from './http';
import { newId, now, bookingReference } from './http';
import {
  CONFLICTING_BOOKING_SQL,
  OVERLAPPING_CLOSURE_SQL,
  canonicalIso,
  closureBinds,
} from './availability-sql';
import { quotePrice } from './pricing-engine';
import type { BookingStatus } from '@shared/types';
import type { PriceBreakdown } from '@shared/pricing';

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

export type CreateBookingFailure = {
  ok: false;
  code: 'resource_not_found' | 'inactive' | 'closure' | 'conflict' | 'no_price';
  message: string;
};

export type CreateBookingResult =
  | {
      ok: true;
      bookingId: string;
      reference: string;
      status: BookingStatus;
      totalPence: number;
      startsAt: string;
      endsAt: string;
      price: PriceBreakdown;
    }
  | CreateBookingFailure;

/** A fully resolved booking ready to be written. */
export interface BookingDraft {
  id: string;
  reference: string;
  userId: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  categoryId: string;
  price: PriceBreakdown;
  organisationId: string | null;
  actorId: string;
  eventType: string;
}

/**
 * Statements that write one booking atomically. The booking row is inserted by
 * a single `INSERT ... SELECT ... WHERE NOT EXISTS (conflict) AND NOT EXISTS
 * (closure)`: D1 executes each statement atomically against a single SQLite
 * writer, so the availability check and the write cannot be interleaved with
 * a competing request. The allocation and event rows are only inserted if the
 * booking row exists. Run them in one batch (a transaction).
 */
export function bookingInsertStatements(env: Env, d: BookingDraft): D1PreparedStatement[] {
  const ts = now();
  const insertBooking = env.DB.prepare(
    `INSERT INTO bookings (id, reference, user_id, resource_id, starts_at, ends_at, status, category_id, pricing_model,
                           unit_price_pence, total_amount_pence, approved_by, cancelled_by, created_at, updated_at,
                           organisation_id, created_by, base_amount_pence, discount_pence, discount_label,
                           pricing_rate_id, pricing_discount_id, price_breakdown, organisation_pricing_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (${CONFLICTING_BOOKING_SQL})
       AND NOT EXISTS (${OVERLAPPING_CLOSURE_SQL})`,
  ).bind(
    d.id,
    d.reference,
    d.userId,
    d.resourceId,
    d.startsAt,
    d.endsAt,
    d.status,
    d.categoryId,
    d.price.pricing_model,
    d.price.unit_price_pence,
    d.price.total_pence,
    ts,
    ts,
    d.organisationId,
    d.actorId,
    d.price.base_amount_pence,
    d.price.discount_pence,
    d.price.discount_label,
    d.price.pricing_rate_id,
    d.price.pricing_discount_id,
    JSON.stringify(d.price),
    d.price.organisation_pricing_id,
    d.resourceId,
    d.resourceId,
    d.resourceId,
    d.endsAt,
    d.startsAt,
    d.id,
    ...closureBinds(d.resourceId),
    d.endsAt,
    d.startsAt,
  );

  const insertAllocation = env.DB.prepare(
    'INSERT INTO booking_resources (booking_id, resource_id) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)',
  ).bind(d.id, d.resourceId, d.id);

  const insertEvent = env.DB.prepare(
    `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at)
     SELECT ?, ?, ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)`,
  ).bind(newId('bev'), d.id, d.eventType, d.actorId, ts, d.id);

  return [insertBooking, insertAllocation, insertEvent];
}

/** Resource checks and server-side price for a requested booking. */
export async function prepareBooking(
  params: CreateBookingParams,
): Promise<{ ok: true; draft: BookingDraft; requiresApproval: boolean } | CreateBookingFailure> {
  const { env } = params;
  const startsAt = canonicalIso(params.startsAt);
  const endsAt = canonicalIso(params.endsAt);

  const resource = await env.DB.prepare('SELECT id, is_active, requires_approval FROM resources WHERE id = ?')
    .bind(params.resourceId)
    .first<{ id: string; is_active: number; requires_approval: number }>();
  if (!resource) return { ok: false, code: 'resource_not_found', message: 'Resource not found' };
  if (!resource.is_active) return { ok: false, code: 'inactive', message: 'Resource is not available' };

  const quote = await quotePrice(env, {
    resourceId: params.resourceId,
    userId: params.userId,
    organisationId: params.organisationId,
    startsAt,
    endsAt,
  });
  if (!quote.ok) {
    return quote.code === 'not_found'
      ? { ok: false, code: 'resource_not_found', message: quote.message }
      : { ok: false, code: 'no_price', message: 'No price configured for your category' };
  }

  // Closures are checked first so the customer gets the more specific message;
  // the atomic insert re-checks both conditions regardless.
  const closure = await env.DB.prepare(OVERLAPPING_CLOSURE_SQL)
    .bind(...closureBinds(params.resourceId), endsAt, startsAt)
    .first();
  if (closure) return { ok: false, code: 'closure', message: 'Resource is unavailable for this period' };

  const status: BookingStatus = resource.requires_approval ? 'pending_approval' : 'confirmed';
  return {
    ok: true,
    requiresApproval: !!resource.requires_approval,
    draft: {
      id: newId('bk'),
      reference: bookingReference(),
      userId: params.userId,
      resourceId: params.resourceId,
      startsAt,
      endsAt,
      status,
      categoryId: quote.categoryId,
      price: quote.breakdown,
      organisationId: params.organisationId ?? null,
      actorId: params.actorId,
      eventType: status === 'confirmed' ? 'confirmed' : 'created',
    },
  };
}

/** Atomically create a single booking (see bookingInsertStatements). */
export async function createBookingAtomic(params: CreateBookingParams): Promise<CreateBookingResult> {
  const prepared = await prepareBooking(params);
  if (!prepared.ok) return prepared;
  const d = prepared.draft;
  const [bookingResult] = await params.env.DB.batch(bookingInsertStatements(params.env, d));
  if (bookingResult.meta.changes !== 1) {
    return { ok: false, code: 'conflict', message: 'The requested period is no longer available' };
  }
  return {
    ok: true,
    bookingId: d.id,
    reference: d.reference,
    status: d.status,
    totalPence: d.price.total_pence,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    price: d.price,
  };
}
