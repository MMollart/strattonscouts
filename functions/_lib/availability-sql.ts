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
 * Resources form a hierarchy through `resources.parent_id` (Whole Venue >
 * Indoor > Main Hall). Booking or closing a resource blocks every resource
 * above it and every resource below it, but never its siblings: booking the
 * Main Hall leaves the Small Hall free, while Indoor and the Whole Venue are
 * taken. UNION (not UNION ALL) makes the recursion stop even if bad data ever
 * contained a cycle.
 */
const ANCESTORS_CTE = `up(id) AS (
    SELECT parent_id FROM resources WHERE id = ? AND parent_id IS NOT NULL
    UNION SELECT r.parent_id FROM resources r JOIN up ON r.id = up.id WHERE r.parent_id IS NOT NULL)`;
const DESCENDANTS_CTE = `down(id) AS (
    SELECT id FROM resources WHERE parent_id = ?
    UNION SELECT r.id FROM resources r JOIN down ON r.parent_id = down.id)`;

/** Resource ids above `resourceId` in the hierarchy. Binds: resourceId. */
export const ANCESTORS_SQL = `WITH RECURSIVE ${ANCESTORS_CTE} SELECT id AS resource_id FROM up`;

/** Resource ids below `resourceId` in the hierarchy. Binds: resourceId. */
export const DESCENDANTS_SQL = `WITH RECURSIVE ${DESCENDANTS_CTE} SELECT id AS resource_id FROM down`;

/**
 * Resource ids blocked by `resourceId`: itself, its ancestors and its
 * descendants. Binds: resourceId x3 (ancestors, descendants, itself).
 */
export const BLOCKED_SET_SQL = `
  WITH RECURSIVE ${ANCESTORS_CTE}, ${DESCENDANTS_CTE}
  SELECT id AS resource_id FROM up UNION SELECT id FROM down UNION SELECT ?`;

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
 * Closures that make a resource unavailable: those on the resource itself, its
 * ancestors (closing the Whole Venue closes every hall) and its descendants
 * (closing a hall makes Indoor and the Whole Venue unavailable). Closing one
 * hall does not close its sibling. Binds: closureBinds.
 */
export const APPLICABLE_CLOSURES_SQL = `
  SELECT c.resource_id, c.starts_at, c.ends_at FROM resource_closures c
  WHERE c.resource_id IN (${BLOCKED_SET_SQL})`;

/** Binds for APPLICABLE_CLOSURES_SQL. */
export function closureBinds(resourceId: string): string[] {
  return [resourceId, resourceId, resourceId];
}

/** An applicable closure overlapping the window. Binds: closureBinds, endsAt, startsAt. */
export const OVERLAPPING_CLOSURE_SQL = `
  SELECT 1 FROM (${APPLICABLE_CLOSURES_SQL}) ac WHERE ac.starts_at < ? AND ac.ends_at > ?`;

/** Normalise any accepted ISO-8601 input to canonical UTC (`...sssZ`) so text comparison is chronological. */
export function canonicalIso(value: string): string {
  return new Date(value).toISOString();
}

/** How the resource behind a busy period relates to the one being checked. */
export type BlockRelation = 'self' | 'parent' | 'child';

export interface BusyPeriod {
  starts_at: string;
  ends_at: string;
  kind: 'booked' | 'closed';
  /** The resource that is booked or closed, so the customer can see why (for example "Whole Venue"). */
  resource_name: string;
  relation: BlockRelation;
}

/**
 * Periods within [from, to) when `resourceId` cannot be booked, each naming
 * the resource that causes it. Contains no customer or booking details, so it
 * is safe to return from public endpoints.
 */
export async function loadBusyPeriods(
  env: Env,
  resourceId: string,
  from: string,
  to: string,
): Promise<BusyPeriod[]> {
  type Row = { starts_at: string; ends_at: string; resource_id: string; resource_name: string };
  const [bookings, closures, ancestors] = await env.DB.batch<Row>([
    env.DB.prepare(
      `SELECT b.starts_at, b.ends_at, b.resource_id, r.name AS resource_name
       FROM bookings b JOIN resources r ON r.id = b.resource_id
       WHERE ${activeBookingSql('b')}
         AND b.resource_id IN (${BLOCKED_SET_SQL})
         AND b.starts_at < ? AND b.ends_at > ?
       ORDER BY b.starts_at`,
    ).bind(resourceId, resourceId, resourceId, to, from),
    env.DB.prepare(
      `SELECT ac.starts_at, ac.ends_at, ac.resource_id, r.name AS resource_name
       FROM (${APPLICABLE_CLOSURES_SQL}) ac JOIN resources r ON r.id = ac.resource_id
       WHERE ac.starts_at < ? AND ac.ends_at > ? ORDER BY ac.starts_at`,
    ).bind(...closureBinds(resourceId), to, from),
    env.DB.prepare(ANCESTORS_SQL).bind(resourceId),
  ]);
  const above = new Set((ancestors.results as unknown as { resource_id: string }[]).map((a) => a.resource_id));
  const relation = (id: string): BlockRelation => (id === resourceId ? 'self' : above.has(id) ? 'parent' : 'child');
  const period = (kind: BusyPeriod['kind']) => (r: Row): BusyPeriod => ({
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    kind,
    resource_name: r.resource_name,
    relation: relation(r.resource_id),
  });
  return [...bookings.results.map(period('booked')), ...closures.results.map(period('closed'))].sort((a, b) =>
    a.starts_at.localeCompare(b.starts_at),
  );
}
