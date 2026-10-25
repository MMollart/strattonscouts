import type { Env } from './http';
import { bookingReference, newId, now } from './http';
import { loadBusyPeriods } from './availability-sql';
import { loadRestrictions } from './restrictions';
import { loadPricingContext, quoteFromContext } from './pricing-engine';
import { bookingInsertStatements, type BookingDraft } from './booking';
import { abortIf, guardedBatch } from './txn';
import { evaluateRestrictions } from '@shared/availability-rules';
import { generateOccurrences, type RecurrencePattern } from '@shared/recurrence';
import type { PriceBreakdown } from '@shared/pricing';
import { agreementsFor, type BookingAcceptance } from './booking';
import { seriesAcceptanceStatements } from './agreements';
import type { BookingStatus } from '@shared/types';

/**
 * Recurring bookings (FR05). Every occurrence is validated like a single
 * booking: conflicts through the resource hierarchy, closures, availability
 * rules and advance limits, and pricing at its own date. Rules, busy periods
 * and prices are loaded once for the whole series so a long series stays
 * within D1's per-request query budget.
 */

export type OccurrenceProblem = 'past' | 'closure' | 'conflict' | 'restricted' | 'no_price';

export interface OccurrencePreview {
  date: string;
  starts_at: string;
  ends_at: string;
  available: boolean;
  reason?: OccurrenceProblem;
  message?: string;
  price?: PriceBreakdown;
}

export interface SeriesRequest {
  userId: string;
  actorId: string;
  resourceId: string;
  organisationId: string | null;
  pattern: RecurrencePattern;
}

type Failure = { ok: false; code: 'resource_not_found' | 'inactive' | 'not_found' | 'empty'; message: string };

const PROBLEM_MESSAGE: Record<Exclude<OccurrenceProblem, 'restricted'>, string> = {
  past: 'This date has already passed.',
  closure: 'The venue is closed for some of this time.',
  conflict: 'This clashes with an existing booking.',
  no_price: 'No price is configured for this date.',
};

export async function previewSeries(
  env: Env,
  req: SeriesRequest,
): Promise<{ ok: true; occurrences: OccurrencePreview[]; requiresApproval: boolean; categoryId: string; resourceName: string } | Failure> {
  const resource = await env.DB.prepare('SELECT id, name, is_active, requires_approval FROM resources WHERE id = ?')
    .bind(req.resourceId)
    .first<{ id: string; name: string; is_active: number; requires_approval: number }>();
  if (!resource) return { ok: false, code: 'resource_not_found', message: 'Resource not found' };
  if (!resource.is_active) return { ok: false, code: 'inactive', message: 'Resource is not available' };

  const occurrences = generateOccurrences(req.pattern);
  if (!occurrences.length) return { ok: false, code: 'empty', message: 'This pattern has no dates' };

  const ctx = await loadPricingContext(env, { resourceId: req.resourceId, userId: req.userId, organisationId: req.organisationId });
  if (!ctx) return { ok: false, code: 'not_found', message: req.organisationId ? 'Organisation not found' : 'Customer not found' };
  const restrictions = await loadRestrictions(env, req.resourceId);
  const busy = await loadBusyPeriods(env, req.resourceId, occurrences[0].startsAt, occurrences[occurrences.length - 1].endsAt);
  const nowMs = Date.now();

  const previews = occurrences.map((o): OccurrencePreview => {
    const base = { date: o.date, starts_at: o.startsAt, ends_at: o.endsAt };
    const overlaps = (kind: 'booked' | 'closed') => busy.some((p) => p.kind === kind && p.starts_at < o.endsAt && p.ends_at > o.startsAt);
    if (Date.parse(o.startsAt) <= nowMs) return { ...base, available: false, reason: 'past', message: PROBLEM_MESSAGE.past };
    if (overlaps('closed')) return { ...base, available: false, reason: 'closure', message: PROBLEM_MESSAGE.closure };
    if (overlaps('booked')) return { ...base, available: false, reason: 'conflict', message: PROBLEM_MESSAGE.conflict };
    const violations = evaluateRestrictions({ startsAt: o.startsAt, endsAt: o.endsAt, now: nowMs, ...restrictions });
    if (violations.length) return { ...base, available: false, reason: 'restricted', message: violations.map((v) => v.message).join(' ') };
    const quote = quoteFromContext(ctx, o.startsAt, o.endsAt);
    if (!quote.ok) return { ...base, available: false, reason: 'no_price', message: PROBLEM_MESSAGE.no_price };
    return { ...base, available: true, price: quote.breakdown };
  });

  return { ok: true, occurrences: previews, requiresApproval: !!resource.requires_approval, categoryId: ctx.categoryId, resourceName: resource.name };
}

export type CreateSeriesResult =
  | { ok: true; seriesId: string; reference: string; status: BookingStatus; bookings: { id: string; date: string; startsAt: string; endsAt: string }[]; totalPence: number; resourceName: string }
  | Failure
  | { ok: false; code: 'unavailable'; message: string; occurrences: OccurrencePreview[] }
  | { ok: false; code: 'conflict'; message: string };

/**
 * Create a series all-or-nothing. Dates the customer explicitly excluded are
 * skipped; any other unavailable date fails the whole request (§6.4: no
 * partial series without the customer's approval). Every occurrence is
 * written by the same atomic conditional insert as a single booking, and a
 * guard rolls the batch back if any of them lost a race.
 */
export async function createSeries(env: Env, req: SeriesRequest, excludeDates: string[], acceptance: BookingAcceptance | null = null): Promise<CreateSeriesResult> {
  const preview = await previewSeries(env, req);
  if (!preview.ok) return preview;
  const excluded = new Set(excludeDates);
  const selected = preview.occurrences.filter((o) => !excluded.has(o.date));
  if (!selected.length) return { ok: false, code: 'empty', message: 'Every date has been removed from this series' };
  if (selected.some((o) => !o.available)) {
    return {
      ok: false,
      code: 'unavailable',
      message: 'Some dates are not available. Remove them to continue with the remaining dates, or cancel the request.',
      occurrences: preview.occurrences,
    };
  }

  const seriesId = newId('ser');
  const reference = bookingReference();
  const status: BookingStatus = preview.requiresApproval ? 'pending_approval' : 'confirmed';
  const ts = now();
  const p = req.pattern;

  const drafts: BookingDraft[] = selected.map((o) => ({
    id: newId('bk'),
    reference: bookingReference(),
    userId: req.userId,
    resourceId: req.resourceId,
    startsAt: o.starts_at,
    endsAt: o.ends_at,
    status,
    expiresAt: null,
    categoryId: preview.categoryId,
    price: o.price!,
    organisationId: req.organisationId,
    actorId: req.actorId,
    eventType: status === 'confirmed' ? 'confirmed' : 'created',
    seriesId,
    overrides: [],
  }));

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO recurrence_series (id, reference, user_id, organisation_id, resource_id, frequency, monthly_mode, start_date, start_time, end_time,
                                      until_date, occurrence_count, excluded_dates, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).bind(
      seriesId, reference, req.userId, req.organisationId, req.resourceId, p.frequency, p.frequency === 'monthly' ? (p.monthlyMode ?? 'day_of_month') : null,
      p.startDate, p.startTime, p.endTime, p.untilDate ?? null, p.count ?? null, JSON.stringify([...excluded].sort()), req.actorId, ts, ts,
    ),
  ];
  // Only the conditional booking insert is needed per occurrence; allocations
  // and events are written for the whole series in one statement each.
  for (const d of drafts) statements.push(bookingInsertStatements(env, d)[0]);
  statements.push(
    abortIf(env, '(SELECT COUNT(*) FROM bookings WHERE series_id = ?) <> ?', seriesId, drafts.length),
    env.DB.prepare(
      `INSERT OR REPLACE INTO booking_resources (booking_id, resource_id, total_amount_pence, base_amount_pence, discount_pence, discount_label, price_breakdown)
       SELECT id, resource_id, total_amount_pence, base_amount_pence, discount_pence, discount_label, price_breakdown FROM bookings WHERE series_id = ?`,
    ).bind(seriesId),
    env.DB.prepare(
      `INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at)
       SELECT 'bev_' || lower(hex(randomblob(16))), id, ?, ?, ?, ? FROM bookings WHERE series_id = ?`,
    ).bind(drafts[0].eventType, req.actorId, JSON.stringify({ series_id: seriesId }), ts, seriesId),
  );
  if (acceptance) statements.push(...seriesAcceptanceStatements(env, acceptance.signature, seriesId, agreementsFor(acceptance, req.resourceId)));

  const result = await guardedBatch(env, statements);
  if (!result) return { ok: false, code: 'conflict', message: 'Some of these dates were booked by someone else just now. Please check again.' };
  return {
    ok: true,
    seriesId,
    reference,
    status,
    bookings: drafts.map((d, i) => ({ id: d.id, date: selected[i].date, startsAt: d.startsAt, endsAt: d.endsAt })),
    totalPence: drafts.reduce((sum, d) => sum + d.price.total_pence, 0),
    resourceName: preview.resourceName,
  };
}

/** Booking-date placeholder for a series email, e.g. "12 dates from Tue 6 Jan 2026 to Tue 24 Mar 2026". */
export function seriesDateText(count: number, first: string, last: string): string {
  return count === 1 ? first : `${count} dates from ${first} to ${last}`;
}
