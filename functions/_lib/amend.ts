import type { Env } from './http';
import { newId, now } from './http';
import { ANCESTORS_SQL, CONFLICTING_BOOKING_SQL, OVERLAPPING_CLOSURE_SQL, activeBookingSql, canonicalIso, closureBinds, conflictBinds } from './availability-sql';
import { loadPricingContext, quoteFromContext, type PricingContext } from './pricing-engine';
import { loadRestrictions } from './restrictions';
import { abortIf } from './txn';
import { bookingLineStatements, type BookingLine, type RestrictionOverride } from './booking';
import { OVERRIDABLE, evaluateRestrictions, type RestrictionKind, type RuleViolation } from '@shared/availability-rules';
import { combinePrices, type PriceBreakdown } from '@shared/pricing';

/**
 * Moving existing bookings to a new time or set of resources, used by
 * recurring series management (FR05) and approved customer amendments
 * (FR12). A change is validated exactly like a new booking (conflicts
 * excluding the booking itself, closures, availability rules, a fresh price
 * at the new date, for every resource it will hold) and is written by
 * status- and availability-guarded UPDATEs, so a batch of changes is
 * all-or-nothing.
 */

export interface AmendTarget {
  id: string;
  user_id: string;
  organisation_id: string | null;
  /** The booking's first resource. */
  resource_id: string;
  /** Every resource the booking holds (defaults to resource_id alone). */
  resource_ids?: string[];
  starts_at: string;
  ends_at: string;
  total_amount_pence: number;
}

export interface AmendChange {
  target: AmendTarget;
  /** The resources the booking will hold; the first becomes its main resource. */
  resourceIds: string[];
  startsAt: string;
  endsAt: string;
}

export interface PlannedChange extends AmendChange {
  categoryId: string;
  /** The whole booking's new price. */
  price: PriceBreakdown;
  /** Each resource's new price. */
  lines: BookingLine[];
  overrides: { kind: RestrictionKind; detail: string; reason: string }[];
}

export interface AmendProblem {
  booking_id: string;
  starts_at: string;
  ends_at: string;
  reason: 'inactive' | 'no_price' | 'closure' | 'conflict' | 'restricted' | 'past';
  message: string;
  violations?: RuleViolation[];
}

/** The resources a booking currently holds. */
export function heldResources(t: AmendTarget): string[] {
  return t.resource_ids?.length ? t.resource_ids : [t.resource_id];
}

/** A booking's resources, read from booking_resources (for AmendTarget.resource_ids). */
export async function loadHeldResources(env: Env, bookingIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!bookingIds.length) return out;
  const rows = await env.DB.prepare(
    `SELECT br.booking_id, br.resource_id FROM booking_resources br JOIN resources r ON r.id = br.resource_id
     WHERE br.booking_id IN (${bookingIds.map(() => '?').join(', ')}) ORDER BY r.name`,
  )
    .bind(...bookingIds)
    .all<{ booking_id: string; resource_id: string }>();
  for (const r of rows.results) out.set(r.booking_id, [...(out.get(r.booking_id) ?? []), r.resource_id]);
  return out;
}

/**
 * Validate and price a set of changes for bookings that share a customer (or
 * organisation). Returns every problem found, or the planned changes ready
 * for `amendStatements`.
 */
export async function planAmendments(
  env: Env,
  changes: AmendChange[],
  opts: { override?: RestrictionOverride | null } = {},
): Promise<{ ok: true; planned: PlannedChange[] } | { ok: false; problems: AmendProblem[] }> {
  if (!changes.length) return { ok: true, planned: [] };
  const first = changes[0];
  const allIds = [...new Set(changes.flatMap((c) => c.resourceIds))];
  const resources = await env.DB.prepare(`SELECT id, name, is_active FROM resources WHERE id IN (${allIds.map(() => '?').join(', ')})`)
    .bind(...allIds)
    .all<{ id: string; name: string; is_active: number }>();
  const byId = new Map(resources.results.map((r) => [r.id, r]));
  // Pricing and rules are loaded once per resource.
  const contexts = new Map<string, PricingContext | null>();
  const rules = new Map<string, Awaited<ReturnType<typeof loadRestrictions>>>();
  for (const id of allIds) {
    contexts.set(id, await loadPricingContext(env, { resourceId: id, userId: first.target.user_id, organisationId: first.target.organisation_id }));
    rules.set(id, await loadRestrictions(env, id));
  }
  const allowed = new Set((opts.override?.kinds ?? []).filter((k) => OVERRIDABLE.includes(k)));

  // A resource and one it is part of cannot be held together.
  const ancestors = await env.DB.batch<{ resource_id: string }>(allIds.map((id) => env.DB.prepare(ANCESTORS_SQL).bind(id)));
  const above = new Map(allIds.map((id, i) => [id, new Set(ancestors[i].results.map((a) => a.resource_id))]));

  // One round trip for every conflict and closure check.
  const pairs = changes.flatMap((c) => c.resourceIds.map((resourceId) => ({ c, resourceId })));
  const checks = await env.DB.batch<{ hit: number }>(
    pairs.flatMap(({ c, resourceId }) => {
      const startsAt = canonicalIso(c.startsAt);
      const endsAt = canonicalIso(c.endsAt);
      return [
        env.DB.prepare(`SELECT EXISTS (${CONFLICTING_BOOKING_SQL}) AS hit`).bind(...conflictBinds(resourceId, startsAt, endsAt, c.target.id)),
        env.DB.prepare(`SELECT EXISTS (${OVERLAPPING_CLOSURE_SQL}) AS hit`).bind(...closureBinds(resourceId), endsAt, startsAt),
      ];
    }),
  );
  const hit = (c: AmendChange, resourceId: string, kind: 0 | 1) => !!checks[pairs.findIndex((p) => p.c === c && p.resourceId === resourceId) * 2 + kind]?.results[0]?.hit;

  const problems: AmendProblem[] = [];
  const planned: PlannedChange[] = [];
  const nowMs = Date.now();
  for (const c of changes) {
    const startsAt = canonicalIso(c.startsAt);
    const endsAt = canonicalIso(c.endsAt);
    const base = { booking_id: c.target.id, starts_at: startsAt, ends_at: endsAt };
    const several = c.resourceIds.length > 1;
    const name = (id: string) => byId.get(id)?.name ?? 'A resource';
    const about = (id: string, message: string) => (several ? `${name(id)}: ${message}` : message);
    const problem = (p: Omit<AmendProblem, keyof typeof base>) => problems.push({ ...base, ...p });

    if (!c.resourceIds.length) { problem({ reason: 'inactive', message: 'A booking must include at least one resource.' }); continue; }
    if (Date.parse(startsAt) <= nowMs) { problem({ reason: 'past', message: 'The new time has already passed.' }); continue; }
    const nested = c.resourceIds.find((id) => c.resourceIds.some((other) => above.get(id)?.has(other)));
    if (nested) {
      const parent = c.resourceIds.find((other) => above.get(nested)?.has(other))!;
      problem({ reason: 'conflict', message: `${name(nested)} is part of ${name(parent)}, so they cannot be booked together.` });
      continue;
    }

    const lines: BookingLine[] = [];
    const overrides: PlannedChange['overrides'] = [];
    let categoryId = '';
    let failed = false;
    for (const id of c.resourceIds) {
      if (!byId.get(id)?.is_active) { problem({ reason: 'inactive', message: about(id, 'This resource is not currently available.') }); failed = true; break; }
      if (hit(c, id, 1)) { problem({ reason: 'closure', message: about(id, 'The venue is closed for some of this time.') }); failed = true; break; }
      if (hit(c, id, 0)) { problem({ reason: 'conflict', message: about(id, 'This clashes with an existing booking.') }); failed = true; break; }
      const violations = evaluateRestrictions({ startsAt, endsAt, now: nowMs, ...rules.get(id)! });
      const blocking = violations.filter((v) => !allowed.has(v.kind));
      if (blocking.length) {
        problem({ reason: 'restricted', message: about(id, blocking.map((v) => v.message).join(' ')), violations: blocking });
        failed = true;
        break;
      }
      const ctx = contexts.get(id);
      const quote = ctx ? quoteFromContext(ctx, startsAt, endsAt) : null;
      if (!quote?.ok) { problem({ reason: 'no_price', message: about(id, 'No price is configured for this booking.') }); failed = true; break; }
      categoryId = quote.categoryId;
      lines.push({ resourceId: id, price: quote.breakdown });
      overrides.push(...violations.map((v) => ({ kind: v.kind, detail: about(id, v.message), reason: opts.override!.reason })));
    }
    if (failed) continue;
    const price = combinePrices(lines.map((l) => ({ ...l.price, resource_id: l.resourceId, resource_name: name(l.resourceId) })));
    planned.push({ ...c, startsAt, endsAt, categoryId, price, lines, overrides });
  }
  return problems.length ? { ok: false, problems } : { ok: true, planned };
}

/** Each resource's price from a whole-booking price (its lines, or the one resource). */
export function linesFromPrice(price: PriceBreakdown, resourceIds: string[]): BookingLine[] {
  if (price.lines?.length) return price.lines.map(({ resource_id, resource_name: _n, ...p }) => (void _n, { resourceId: resource_id, price: p }));
  return [{ resourceId: resourceIds[0], price }];
}

/**
 * Statements applying one planned change. The UPDATE only succeeds while the
 * booking is still active and every resource it will hold is free (excluding
 * the booking itself) and open; otherwise the guard aborts the whole batch.
 * The booking's resources are then replaced with the new set and prices.
 */
export function amendStatements(env: Env, c: PlannedChange, actorId: string, detail: Record<string, unknown> = {}): D1PreparedStatement[] {
  const ts = now();
  const p = c.price;
  const guards = c.lines.map(() => `AND NOT EXISTS (${CONFLICTING_BOOKING_SQL}) AND NOT EXISTS (${OVERLAPPING_CLOSURE_SQL})`).join('\n         ');
  const guardBinds = c.lines.flatMap((l) => [...conflictBinds(l.resourceId, c.startsAt, c.endsAt, c.target.id), ...closureBinds(l.resourceId), c.endsAt, c.startsAt]);
  return [
    env.DB.prepare(
      `UPDATE bookings SET resource_id = ?, starts_at = ?, ends_at = ?, category_id = ?, pricing_model = ?, unit_price_pence = ?,
              total_amount_pence = ?, base_amount_pence = ?, discount_pence = ?, discount_label = ?, pricing_rate_id = ?,
              pricing_discount_id = ?, price_breakdown = ?, organisation_pricing_id = ?, updated_at = ?
       WHERE id = ? AND ${activeBookingSql('')}
         ${guards}`,
    ).bind(
      c.lines[0].resourceId, c.startsAt, c.endsAt, c.categoryId, p.pricing_model, p.unit_price_pence, p.total_pence, p.base_amount_pence,
      p.discount_pence, p.discount_label, p.pricing_rate_id, p.pricing_discount_id, JSON.stringify(p), p.organisation_pricing_id, ts,
      c.target.id,
      ...guardBinds,
    ),
    abortIf(env, 'changes() = 0'),
    env.DB.prepare('DELETE FROM booking_resources WHERE booking_id = ?').bind(c.target.id),
    ...bookingLineStatements(env, c.target.id, c.lines),
    env.DB.prepare(
      `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at) VALUES (?, ?, 'amended', ?, ?, ?)`,
    ).bind(
      newId('bev'),
      c.target.id,
      actorId,
      JSON.stringify({
        ...detail,
        from: { resource_id: c.target.resource_id, resource_ids: heldResources(c.target), starts_at: c.target.starts_at, ends_at: c.target.ends_at, total_pence: c.target.total_amount_pence },
        to: { resource_id: c.lines[0].resourceId, resource_ids: c.lines.map((l) => l.resourceId), starts_at: c.startsAt, ends_at: c.endsAt, total_pence: p.total_pence },
      }),
      ts,
    ),
    ...c.overrides.map((o) =>
      env.DB.prepare(
        'INSERT INTO availability_overrides (id, booking_id, rule, detail, admin_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(newId('ovr'), c.target.id, o.kind, o.detail, actorId, o.reason, ts),
    ),
  ];
}
