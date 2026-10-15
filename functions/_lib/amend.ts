import type { Env } from './http';
import { newId, now } from './http';
import { CONFLICTING_BOOKING_SQL, OVERLAPPING_CLOSURE_SQL, activeBookingSql, canonicalIso, closureBinds } from './availability-sql';
import { loadPricingContext, quoteFromContext } from './pricing-engine';
import { loadRestrictions } from './restrictions';
import { abortIf } from './txn';
import type { RestrictionOverride } from './booking';
import { OVERRIDABLE, evaluateRestrictions, type RestrictionKind, type RuleViolation } from '@shared/availability-rules';
import type { PriceBreakdown } from '@shared/pricing';

/**
 * Moving existing bookings to a new time or resource, used by recurring
 * series management (FR05) and approved customer amendments (FR12). A change
 * is validated exactly like a new booking (conflicts excluding the booking
 * itself, closures, availability rules, a fresh price at the new date) and is
 * written by status- and availability-guarded UPDATEs, so a batch of changes
 * is all-or-nothing.
 */

export interface AmendTarget {
  id: string;
  user_id: string;
  organisation_id: string | null;
  resource_id: string;
  starts_at: string;
  ends_at: string;
  total_amount_pence: number;
}

export interface AmendChange {
  target: AmendTarget;
  resourceId: string;
  startsAt: string;
  endsAt: string;
}

export interface PlannedChange extends AmendChange {
  categoryId: string;
  price: PriceBreakdown;
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

/**
 * Validate and price a set of changes for bookings that share a customer (or
 * organisation) and resource. Returns every problem found, or the planned
 * changes ready for `amendStatements`.
 */
export async function planAmendments(
  env: Env,
  changes: AmendChange[],
  opts: { override?: RestrictionOverride | null } = {},
): Promise<{ ok: true; planned: PlannedChange[] } | { ok: false; problems: AmendProblem[] }> {
  if (!changes.length) return { ok: true, planned: [] };
  const first = changes[0];
  const resource = await env.DB.prepare('SELECT is_active FROM resources WHERE id = ?').bind(first.resourceId).first<{ is_active: number }>();
  const ctx = await loadPricingContext(env, { resourceId: first.resourceId, userId: first.target.user_id, organisationId: first.target.organisation_id });
  const restrictions = await loadRestrictions(env, first.resourceId);
  const allowed = new Set((opts.override?.kinds ?? []).filter((k) => OVERRIDABLE.includes(k)));

  // One round trip for every conflict and closure check.
  const checks = await env.DB.batch<{ hit: number }>(
    changes.flatMap((c) => {
      const startsAt = canonicalIso(c.startsAt);
      const endsAt = canonicalIso(c.endsAt);
      return [
        env.DB.prepare(`SELECT EXISTS (${CONFLICTING_BOOKING_SQL}) AS hit`).bind(c.resourceId, c.resourceId, c.resourceId, endsAt, startsAt, c.target.id),
        env.DB.prepare(`SELECT EXISTS (${OVERLAPPING_CLOSURE_SQL}) AS hit`).bind(...closureBinds(c.resourceId), endsAt, startsAt),
      ];
    }),
  );

  const problems: AmendProblem[] = [];
  const planned: PlannedChange[] = [];
  const nowMs = Date.now();
  changes.forEach((c, i) => {
    const startsAt = canonicalIso(c.startsAt);
    const endsAt = canonicalIso(c.endsAt);
    const base = { booking_id: c.target.id, starts_at: startsAt, ends_at: endsAt };
    if (!resource?.is_active) return problems.push({ ...base, reason: 'inactive', message: 'This resource is not currently available.' });
    if (Date.parse(startsAt) <= nowMs) return problems.push({ ...base, reason: 'past', message: 'The new time has already passed.' });
    if (checks[i * 2 + 1].results[0]?.hit) return problems.push({ ...base, reason: 'closure', message: 'The venue is closed for some of this time.' });
    if (checks[i * 2].results[0]?.hit) return problems.push({ ...base, reason: 'conflict', message: 'This clashes with an existing booking.' });
    const violations = evaluateRestrictions({ startsAt, endsAt, now: nowMs, ...restrictions });
    const blocking = violations.filter((v) => !allowed.has(v.kind));
    if (blocking.length) return problems.push({ ...base, reason: 'restricted', message: blocking.map((v) => v.message).join(' '), violations: blocking });
    const quote = ctx ? quoteFromContext(ctx, startsAt, endsAt) : null;
    if (!quote?.ok) return problems.push({ ...base, reason: 'no_price', message: 'No price is configured for this booking.' });
    planned.push({
      ...c,
      startsAt,
      endsAt,
      categoryId: quote.categoryId,
      price: quote.breakdown,
      overrides: violations.map((v) => ({ kind: v.kind, detail: v.message, reason: opts.override!.reason })),
    });
  });
  return problems.length ? { ok: false, problems } : { ok: true, planned };
}

/**
 * Statements applying one planned change. The UPDATE only succeeds while the
 * booking is still active and the new period is free (excluding the booking
 * itself) and open; otherwise the guard aborts the whole batch.
 */
export function amendStatements(env: Env, c: PlannedChange, actorId: string, detail: Record<string, unknown> = {}): D1PreparedStatement[] {
  const ts = now();
  const p = c.price;
  return [
    env.DB.prepare(
      `UPDATE bookings SET resource_id = ?, starts_at = ?, ends_at = ?, category_id = ?, pricing_model = ?, unit_price_pence = ?,
              total_amount_pence = ?, base_amount_pence = ?, discount_pence = ?, discount_label = ?, pricing_rate_id = ?,
              pricing_discount_id = ?, price_breakdown = ?, organisation_pricing_id = ?, updated_at = ?
       WHERE id = ? AND ${activeBookingSql('')}
         AND NOT EXISTS (${CONFLICTING_BOOKING_SQL})
         AND NOT EXISTS (${OVERLAPPING_CLOSURE_SQL})`,
    ).bind(
      c.resourceId, c.startsAt, c.endsAt, c.categoryId, p.pricing_model, p.unit_price_pence, p.total_pence, p.base_amount_pence,
      p.discount_pence, p.discount_label, p.pricing_rate_id, p.pricing_discount_id, JSON.stringify(p), p.organisation_pricing_id, ts,
      c.target.id,
      c.resourceId, c.resourceId, c.resourceId, c.endsAt, c.startsAt, c.target.id,
      ...closureBinds(c.resourceId), c.endsAt, c.startsAt,
    ),
    abortIf(env, 'changes() = 0'),
    env.DB.prepare('UPDATE booking_resources SET resource_id = ? WHERE booking_id = ?').bind(c.resourceId, c.target.id),
    env.DB.prepare(
      `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at) VALUES (?, ?, 'amended', ?, ?, ?)`,
    ).bind(
      newId('bev'),
      c.target.id,
      actorId,
      JSON.stringify({
        ...detail,
        from: { resource_id: c.target.resource_id, starts_at: c.target.starts_at, ends_at: c.target.ends_at, total_pence: c.target.total_amount_pence },
        to: { resource_id: c.resourceId, starts_at: c.startsAt, ends_at: c.endsAt, total_pence: p.total_pence },
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
