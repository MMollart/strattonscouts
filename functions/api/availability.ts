import type { Env } from '../_lib/http';
import { error, json } from '../_lib/http';
import { canonicalIso, loadBusyPeriods } from '../_lib/availability-sql';
import { checkRestrictions } from '../_lib/restrictions';

/**
 * Public availability check for one window. Returns only availability
 * information — never other customers' personal data or booking details.
 *
 * Query params: resource_id, starts_at (ISO), ends_at (ISO)
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const resourceId = url.searchParams.get('resource_id');
  const startsAtRaw = url.searchParams.get('starts_at');
  const endsAtRaw = url.searchParams.get('ends_at');

  if (!resourceId || !startsAtRaw || !endsAtRaw) {
    return error('resource_id, starts_at and ends_at are required', 400);
  }
  if (Number.isNaN(Date.parse(startsAtRaw)) || Number.isNaN(Date.parse(endsAtRaw))) {
    return error('starts_at and ends_at must be ISO-8601 date-times', 400);
  }
  const startsAt = canonicalIso(startsAtRaw);
  const endsAt = canonicalIso(endsAtRaw);
  if (endsAt <= startsAt) {
    return error('ends_at must be after starts_at', 400);
  }

  const resource = await env.DB.prepare('SELECT id, is_active FROM resources WHERE id = ?')
    .bind(resourceId)
    .first<{ id: string; is_active: number }>();
  if (!resource) return error('Resource not found', 404);
  if (!resource.is_active) return json({ available: false, reason: 'inactive' });

  const busy = await loadBusyPeriods(env, resourceId, startsAt, endsAt);
  // Name the resource that causes it (this one, a parent that includes it or a
  // child that is part of it), never who booked it.
  const closed = busy.find((p) => p.kind === 'closed');
  const blocker = closed ?? busy[0];
  if (blocker) {
    return json({
      available: false,
      reason: closed ? 'closure' : 'conflict',
      blocked_by: { name: blocker.resource_name, relation: blocker.relation },
    });
  }
  // Booking restrictions (FR03): notice, advance window, recurring rules, opening hours.
  const violations = await checkRestrictions(env, resourceId, startsAt, endsAt);
  if (violations.length) {
    return json({ available: false, reason: 'restricted', violations: violations.map(({ kind, message }) => ({ kind, message })) });
  }
  return json({ available: true });
};
