import type { Env } from './http';

/**
 * SQL building blocks for availability, shared by booking allocation,
 * approval revalidation and the public availability/calendar endpoints.
 *
 * Everything is evaluated inside the database so that a check and the write it
 * guards can run as one atomic statement (see createBookingAtomic).
 */

export const ACTIVE_STATUSES = ['pending_approval', 'confirmed', 'provisional'] as const;

/** The database clock as canonical ISO-8601 UTC, comparable with stored timestamps. */
export const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * A booking that holds its resource: pending approval, confirmed, or
 * provisional and not yet past its expiry (FR04). A provisional booking stops
 * blocking the moment it expires, before the scheduler marks it expired, so
 * availability never depends on the cron having run.
 */
export function activeBookingSql(alias: string): string {
  const a = alias ? `${alias}.` : '';
  return `(${a}status IN ('pending_approval', 'confirmed') OR (${a}status = 'provisional' AND ${a}expires_at > ${NOW_SQL}))`;
}

/** The status to show: provisional bookings past their expiry read as expired. */
export function effectiveStatusSql(alias: string): string {
  const a = alias ? `${alias}.` : '';
  return `(CASE WHEN ${a}status = 'provisional' AND ${a}expires_at <= ${NOW_SQL} THEN 'expired' ELSE ${a}status END)`;
}

/**
 * Resource ids blocked by `resourceId`: itself plus every resource it
 * conflicts with in either direction. Binds: resourceId x3.
 */
export const BLOCKED_SET_SQL = `
  SELECT conflicts_with_id FROM resource_conflicts WHERE resource_id = ?
  UNION SELECT resource_id FROM resource_conflicts WHERE conflicts_with_id = ?
  UNION SELECT ?`;

/**
 * An active booking on any blocked resource overlapping [startsAt, endsAt).
 * Binds: resourceId x3, endsAt, startsAt, excludeBookingId.
 */
export const CONFLICTING_BOOKING_SQL = `
  SELECT 1 FROM bookings ob
  WHERE ${activeBookingSql('ob')}
    AND ob.resource_id IN (${BLOCKED_SET_SQL})
    AND ob.starts_at < ? AND ob.ends_at > ?
    AND ob.id <> ?`;

/**
 * Closures that make a resource unavailable. A closure applies to the resource
 * it was set on and, through the conflict matrix, to combined resources: closing
 * the Whole Venue closes every hall, and closing a hall makes the Whole Venue
 * unavailable. Closing one individual resource does not close another.
 * Binds: resourceId x3, resourceId (self), resourceId (is combined).
 */
export const APPLICABLE_CLOSURES_SQL = `
  SELECT c.resource_id, c.starts_at, c.ends_at FROM resource_closures c
  JOIN resources cr ON cr.id = c.resource_id
  WHERE c.resource_id IN (${BLOCKED_SET_SQL})
    AND (
      c.resource_id = ?
      OR cr.resource_type = 'combined'
      OR (SELECT resource_type FROM resources WHERE id = ?) = 'combined'
    )`;

/** Binds for APPLICABLE_CLOSURES_SQL. */
export function closureBinds(resourceId: string): string[] {
  return [resourceId, resourceId, resourceId, resourceId, resourceId];
}

/** An applicable closure overlapping the window. Binds: closureBinds, endsAt, startsAt. */
export const OVERLAPPING_CLOSURE_SQL = `
  SELECT 1 FROM (${APPLICABLE_CLOSURES_SQL}) ac WHERE ac.starts_at < ? AND ac.ends_at > ?`;

/** Normalise any accepted ISO-8601 input to canonical UTC (`...sssZ`) so text comparison is chronological. */
export function canonicalIso(value: string): string {
  return new Date(value).toISOString();
}

export interface BusyPeriod {
  starts_at: string;
  ends_at: string;
  kind: 'booked' | 'closed';
}

/**
 * Periods within [from, to) when `resourceId` cannot be booked. Contains no
 * customer or booking details, so it is safe to return from public endpoints.
 */
export async function loadBusyPeriods(
  env: Env,
  resourceId: string,
  from: string,
  to: string,
): Promise<BusyPeriod[]> {
  const [bookings, closures] = await env.DB.batch<{ starts_at: string; ends_at: string }>([
    env.DB.prepare(
      `SELECT starts_at, ends_at FROM bookings
       WHERE ${activeBookingSql('')}
         AND resource_id IN (${BLOCKED_SET_SQL})
         AND starts_at < ? AND ends_at > ?
       ORDER BY starts_at`,
    ).bind(resourceId, resourceId, resourceId, to, from),
    env.DB.prepare(
      `SELECT starts_at, ends_at FROM (${APPLICABLE_CLOSURES_SQL}) ac
       WHERE ac.starts_at < ? AND ac.ends_at > ? ORDER BY starts_at`,
    ).bind(...closureBinds(resourceId), to, from),
  ]);
  return [
    ...bookings.results.map((b) => ({ starts_at: b.starts_at, ends_at: b.ends_at, kind: 'booked' as const })),
    ...closures.results.map((c) => ({ starts_at: c.starts_at, ends_at: c.ends_at, kind: 'closed' as const })),
  ].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}
