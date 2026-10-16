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
import { checkRestrictions } from './restrictions';
import type { RestrictionKind, RuleViolation } from '@shared/availability-rules';
import { OVERRIDABLE } from '@shared/availability-rules';
import { provisionalExpiry, provisionalHoldHours } from './provisional';
import { acceptanceStatements, type RequiredAgreement, type SignatureDraft } from './agreements';

/** An authorised administrator's override of booking restrictions (FR03). */
export interface RestrictionOverride {
  kinds: RestrictionKind[];
  reason: string;
}

export interface CreateBookingParams {
  env: Env;
  userId: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  actorId: string; // who is performing the action (customer or admin)
  /** Book on behalf of this organisation; the caller has checked membership. */
  organisationId?: string | null;
  /** Restrictions to override; the caller has checked availability.manage. */
  override?: RestrictionOverride | null;
  /** Hold the resource provisionally until confirmed or expired (FR04). */
  provisional?: boolean;
  /** Hold period for this booking; the caller has checked bookings.manage. */
  provisionalExpiryHours?: number | null;
  /** Agreements accepted with this booking (FR20); the caller has checked them. */
  acceptance?: BookingAcceptance | null;
}

export interface BookingAcceptance {
  signature: SignatureDraft;
  agreements: RequiredAgreement[];
}

/** The accepted agreements that apply to one resource. */
export function agreementsFor(acceptance: BookingAcceptance | null | undefined, resourceId: string): RequiredAgreement[] {
  return acceptance?.agreements.filter((a) => a.resource_ids.includes(resourceId)) ?? [];
}

export type CreateBookingFailure = {
  ok: false;
  code: 'resource_not_found' | 'inactive' | 'closure' | 'conflict' | 'no_price' | 'restricted';
  message: string;
  violations?: RuleViolation[];
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
      expiresAt: string | null;
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
  /** When a provisional hold lapses; null for every other status. */
  expiresAt: string | null;
  categoryId: string;
  price: PriceBreakdown;
  organisationId: string | null;
  actorId: string;
  eventType: string;
  /** The recurring series this booking is an occurrence of (FR05). */
  seriesId?: string | null;
  /** Resources booked together in one request share a group. */
  groupId?: string | null;
  /** Overridden restrictions to record against the booking. */
  overrides: { kind: RestrictionKind; detail: string; reason: string }[];
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
                           pricing_rate_id, pricing_discount_id, price_breakdown, organisation_pricing_id, expires_at, series_id, group_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
    d.expiresAt,
    d.seriesId ?? null,
    d.groupId ?? null,
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

  const insertOverrides = d.overrides.map((o) =>
    env.DB.prepare(
      `INSERT INTO availability_overrides (id, booking_id, rule, detail, admin_id, reason, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)`,
    ).bind(newId('ovr'), d.id, o.kind, o.detail, d.actorId, o.reason, ts, d.id),
  );

  return [insertBooking, insertAllocation, insertEvent, ...insertOverrides];
}

/**
 * Apply restrictions: violations not covered by an override fail the request;
 * overridden ones are returned to be recorded. Conflicts and exceptional
 * closures are never overridable (they are enforced by the atomic insert).
 */
export async function applyRestrictions(
  env: Env,
  args: { resourceId: string; startsAt: string; endsAt: string; override?: RestrictionOverride | null },
): Promise<{ ok: true; overrides: BookingDraft['overrides'] } | CreateBookingFailure> {
  const violations = await checkRestrictions(env, args.resourceId, args.startsAt, args.endsAt);
  const allowed = new Set((args.override?.kinds ?? []).filter((k) => OVERRIDABLE.includes(k)));
  const blocking = violations.filter((v) => !allowed.has(v.kind));
  if (blocking.length) {
    return { ok: false, code: 'restricted', message: blocking.map((v) => v.message).join(' '), violations: blocking };
  }
  return {
    ok: true,
    overrides: violations.map((v) => ({ kind: v.kind, detail: v.message, reason: args.override!.reason })),
  };
}

/** Resource checks and server-side price for a requested booking. */
export async function prepareBooking(
  params: CreateBookingParams,
): Promise<{ ok: true; draft: BookingDraft; requiresApproval: boolean } | CreateBookingFailure> {
  const { env } = params;
  const startsAt = canonicalIso(params.startsAt);
  const endsAt = canonicalIso(params.endsAt);

  const resource = await env.DB.prepare('SELECT id, is_active, requires_approval, provisional_expiry_hours FROM resources WHERE id = ?')
    .bind(params.resourceId)
    .first<{ id: string; is_active: number; requires_approval: number; provisional_expiry_hours: number | null }>();
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

  const restrictions = await applyRestrictions(env, { resourceId: params.resourceId, startsAt, endsAt, override: params.override });
  if (!restrictions.ok) return restrictions;

  // Closures are checked first so the customer gets the more specific message;
  // the atomic insert re-checks both conditions regardless.
  const closure = await env.DB.prepare(OVERLAPPING_CLOSURE_SQL)
    .bind(...closureBinds(params.resourceId), endsAt, startsAt)
    .first();
  if (closure) return { ok: false, code: 'closure', message: 'Resource is unavailable for this period' };

  // A provisional hold (FR04) is confirmed later by an administrator, which
  // also stands in for approval on resources that require it.
  let status: BookingStatus = resource.requires_approval ? 'pending_approval' : 'confirmed';
  let expiresAt: string | null = null;
  if (params.provisional) {
    if (Date.parse(startsAt) <= Date.now()) {
      return { ok: false, code: 'restricted', message: 'A provisional booking must start in the future' };
    }
    status = 'provisional';
    const hours = params.provisionalExpiryHours ?? (await provisionalHoldHours(env, resource.provisional_expiry_hours));
    expiresAt = provisionalExpiry(Date.now(), hours, startsAt);
  }
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
      expiresAt,
      categoryId: quote.categoryId,
      price: quote.breakdown,
      organisationId: params.organisationId ?? null,
      actorId: params.actorId,
      eventType: status === 'confirmed' ? 'confirmed' : status === 'provisional' ? 'provisional' : 'created',
      overrides: restrictions.overrides,
    },
  };
}

/** Atomically create a single booking (see bookingInsertStatements). */
export async function createBookingAtomic(params: CreateBookingParams): Promise<CreateBookingResult> {
  const prepared = await prepareBooking(params);
  if (!prepared.ok) return prepared;
  const d = prepared.draft;
  const statements = bookingInsertStatements(params.env, d);
  if (params.acceptance) {
    statements.push(...acceptanceStatements(params.env, params.acceptance.signature, [{ bookingId: d.id, agreements: agreementsFor(params.acceptance, d.resourceId) }]));
  }
  const [bookingResult] = await params.env.DB.batch(statements);
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
    expiresAt: d.expiresAt,
    price: d.price,
  };
}
