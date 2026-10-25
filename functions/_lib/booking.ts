import type { Env } from './http';
import { newId, now, bookingReference } from './http';
import {
  ANCESTORS_SQL,
  CONFLICTING_BOOKING_SQL,
  OVERLAPPING_CLOSURE_SQL,
  canonicalIso,
  closureBinds,
  conflictBinds,
} from './availability-sql';
import { quotePrice } from './pricing-engine';
import type { BookingStatus } from '@shared/types';
import { combinePrices, type PriceBreakdown, type PriceLine } from '@shared/pricing';
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
  /** The booking's (first) resource. */
  resourceId: string;
  /** Further resources held by the same booking, for the same time. */
  additionalResourceIds?: string[];
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

/** The accepted agreements that apply to any of these resources. */
export function agreementsFor(acceptance: BookingAcceptance | null | undefined, resourceIds: string | string[]): RequiredAgreement[] {
  const ids = Array.isArray(resourceIds) ? resourceIds : [resourceIds];
  return acceptance?.agreements.filter((a) => a.resource_ids.some((id) => ids.includes(id))) ?? [];
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
      resourceIds: string[];
      status: BookingStatus;
      totalPence: number;
      startsAt: string;
      endsAt: string;
      expiresAt: string | null;
      price: PriceBreakdown;
    }
  | CreateBookingFailure;

/** One resource a booking holds, with what it charges. */
export interface BookingLine {
  resourceId: string;
  price: PriceBreakdown;
}

/** A fully resolved booking ready to be written. */
export interface BookingDraft {
  id: string;
  reference: string;
  userId: string;
  /** The booking's first resource. */
  resourceId: string;
  /** Every resource the booking holds (the first is resourceId); defaults to resourceId alone. */
  lines?: BookingLine[];
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  /** When a provisional hold lapses; null for every other status. */
  expiresAt: string | null;
  categoryId: string;
  /** The whole booking's price (each resource's is in lines). */
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
  const lines = draftLines(d);
  // Every resource the booking holds must be free and open.
  const guards = lines.map(() => `NOT EXISTS (${CONFLICTING_BOOKING_SQL}) AND NOT EXISTS (${OVERLAPPING_CLOSURE_SQL})`).join(' AND ');
  const guardBinds = lines.flatMap((l) => [
    ...conflictBinds(l.resourceId, d.startsAt, d.endsAt, d.id),
    ...closureBinds(l.resourceId), d.endsAt, d.startsAt,
  ]);
  const insertBooking = env.DB.prepare(
    `INSERT INTO bookings (id, reference, user_id, resource_id, starts_at, ends_at, status, category_id, pricing_model,
                           unit_price_pence, total_amount_pence, approved_by, cancelled_by, created_at, updated_at,
                           organisation_id, created_by, base_amount_pence, discount_pence, discount_label,
                           pricing_rate_id, pricing_discount_id, price_breakdown, organisation_pricing_id, expires_at, series_id, group_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ${guards}`,
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
    ...guardBinds,
  );

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

  return [insertBooking, ...bookingLineStatements(env, d.id, lines, true), insertEvent, ...insertOverrides];
}

/** A draft's resources, each with its price. */
export function draftLines(d: Pick<BookingDraft, 'resourceId' | 'lines' | 'price'>): BookingLine[] {
  return d.lines?.length ? d.lines : [{ resourceId: d.resourceId, price: d.price }];
}

/**
 * Rows recording which resources a booking holds and what each charges.
 * `ifBookingExists` writes them only when the booking row was written.
 */
export function bookingLineStatements(env: Env, bookingId: string, lines: BookingLine[], ifBookingExists = false): D1PreparedStatement[] {
  return lines.map((l) => {
    const { lines: _nested, ...price } = l.price;
    void _nested;
    return env.DB.prepare(
      `INSERT OR REPLACE INTO booking_resources (booking_id, resource_id, total_amount_pence, base_amount_pence, discount_pence, discount_label, price_breakdown)
       SELECT ?, ?, ?, ?, ?, ?, ?${ifBookingExists ? ' WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)' : ''}`,
    ).bind(
      bookingId, l.resourceId, price.total_pence, price.base_amount_pence, price.discount_pence, price.discount_label, JSON.stringify(price),
      ...(ifBookingExists ? [bookingId] : []),
    );
  });
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

interface ResourceRow { id: string; name: string; is_active: number; requires_approval: number; provisional_expiry_hours: number | null }

/**
 * Resource checks and server-side price for a requested booking of one or
 * more resources. Each resource is checked and priced on its own (rules,
 * closures, price); the booking needs approval if any of them does.
 */
export async function prepareBooking(
  params: CreateBookingParams,
): Promise<{ ok: true; draft: BookingDraft; requiresApproval: boolean } | CreateBookingFailure> {
  const { env } = params;
  const startsAt = canonicalIso(params.startsAt);
  const endsAt = canonicalIso(params.endsAt);
  const ids = [...new Set([params.resourceId, ...(params.additionalResourceIds ?? [])])];
  const several = ids.length > 1;

  const rows = await env.DB.prepare(
    `SELECT id, name, is_active, requires_approval, provisional_expiry_hours FROM resources WHERE id IN (${ids.map(() => '?').join(', ')})`,
  )
    .bind(...ids)
    .all<ResourceRow>();
  const byId = new Map(rows.results.map((r) => [r.id, r]));
  const resources = ids.map((id) => byId.get(id));
  if (resources.some((r) => !r)) return { ok: false, code: 'resource_not_found', message: 'Resource not found' };
  const list = resources as ResourceRow[];
  // Say which resource a problem is with when the booking has several.
  const about = (r: ResourceRow, message: string) => (several ? `${r.name}: ${message}` : message);

  const inactive = list.find((r) => !r.is_active);
  if (inactive) return { ok: false, code: 'inactive', message: about(inactive, 'Resource is not available') };

  // A resource and one it is part of (a hall and the Whole Venue) cannot be
  // booked together: the parent already includes the child.
  if (several) {
    const ancestors = await env.DB.batch<{ resource_id: string }>(ids.map((id) => env.DB.prepare(ANCESTORS_SQL).bind(id)));
    for (const [i, child] of list.entries()) {
      const parent = byId.get(ancestors[i].results.find((a) => ids.includes(a.resource_id))?.resource_id ?? '');
      if (parent) {
        return {
          ok: false,
          code: 'conflict',
          message: `${child.name} is part of ${parent.name}, so they cannot be booked together. ${parent.name} already includes it.`,
        };
      }
    }
  }

  const lines: BookingLine[] = [];
  const overrides: BookingDraft['overrides'] = [];
  let categoryId = '';
  for (const r of list) {
    const quote = await quotePrice(env, { resourceId: r.id, userId: params.userId, organisationId: params.organisationId, startsAt, endsAt });
    if (!quote.ok) {
      return quote.code === 'not_found'
        ? { ok: false, code: 'resource_not_found', message: about(r, quote.message) }
        : { ok: false, code: 'no_price', message: about(r, 'No price configured for your category') };
    }
    categoryId = quote.categoryId;

    const restrictions = await applyRestrictions(env, { resourceId: r.id, startsAt, endsAt, override: params.override });
    if (!restrictions.ok) return { ...restrictions, message: about(r, restrictions.message) };
    overrides.push(...restrictions.overrides.map((o) => ({ ...o, detail: about(r, o.detail) })));

    // Closures are checked first so the customer gets the more specific
    // message; the atomic insert re-checks both conditions regardless.
    const closure = await env.DB.prepare(OVERLAPPING_CLOSURE_SQL).bind(...closureBinds(r.id), endsAt, startsAt).first();
    if (closure) return { ok: false, code: 'closure', message: about(r, 'Resource is unavailable for this period') };
    if (several && (await env.DB.prepare(CONFLICTING_BOOKING_SQL).bind(...conflictBinds(r.id, startsAt, endsAt, '')).first())) {
      return { ok: false, code: 'conflict', message: `${r.name} is already booked at this time, so nothing was booked.` };
    }
    lines.push({ resourceId: r.id, price: quote.breakdown });
  }

  // A provisional hold (FR04) is confirmed later by an administrator, which
  // also stands in for approval on resources that require it.
  const requiresApproval = list.some((r) => r.requires_approval);
  let status: BookingStatus = requiresApproval ? 'pending_approval' : 'confirmed';
  let expiresAt: string | null = null;
  if (params.provisional) {
    if (Date.parse(startsAt) <= Date.now()) {
      return { ok: false, code: 'restricted', message: 'A provisional booking must start in the future' };
    }
    status = 'provisional';
    // The shortest hold of the resources booked.
    const hours = params.provisionalExpiryHours ?? Math.min(...(await Promise.all(list.map((r) => provisionalHoldHours(env, r.provisional_expiry_hours)))));
    expiresAt = provisionalExpiry(Date.now(), hours, startsAt);
  }
  const names = new Map(list.map((r) => [r.id, r.name]));
  const price = combinePrices(lines.map((l): PriceLine => ({ ...l.price, resource_id: l.resourceId, resource_name: names.get(l.resourceId) ?? '' })));
  return {
    ok: true,
    requiresApproval,
    draft: {
      id: newId('bk'),
      reference: bookingReference(),
      userId: params.userId,
      resourceId: params.resourceId,
      lines,
      startsAt,
      endsAt,
      status,
      expiresAt,
      categoryId,
      price,
      organisationId: params.organisationId ?? null,
      actorId: params.actorId,
      eventType: status === 'confirmed' ? 'confirmed' : status === 'provisional' ? 'provisional' : 'created',
      overrides,
    },
  };
}

/** Atomically create a booking of one or more resources (see bookingInsertStatements). */
export async function createBookingAtomic(params: CreateBookingParams): Promise<CreateBookingResult> {
  const prepared = await prepareBooking(params);
  if (!prepared.ok) return prepared;
  const d = prepared.draft;
  const statements = bookingInsertStatements(params.env, d);
  if (params.acceptance) {
    const ids = draftLines(d).map((l) => l.resourceId);
    statements.push(...acceptanceStatements(params.env, params.acceptance.signature, [{ bookingId: d.id, agreements: agreementsFor(params.acceptance, ids) }]));
  }
  const [bookingResult] = await params.env.DB.batch(statements);
  // A trigger also writes the main resource row, so a written booking reports more than one change.
  if (!bookingResult.meta.changes) {
    return { ok: false, code: 'conflict', message: 'The requested period is no longer available' };
  }
  return {
    ok: true,
    bookingId: d.id,
    reference: d.reference,
    resourceIds: draftLines(d).map((l) => l.resourceId),
    status: d.status,
    totalPence: d.price.total_pence,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    expiresAt: d.expiresAt,
    price: d.price,
  };
}
