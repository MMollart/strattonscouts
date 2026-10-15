import { intervalsOverlap } from './pricing';

export interface ConflictEdge {
  resource_id: string;
  conflicts_with_id: string;
}

/**
 * Build the set of resource ids that conflict with a given resource.
 * Conflicts are treated as bidirectional. A resource always conflicts with
 * itself (mandatory self-conflict), which is enforced here defensively even
 * if the edge is somehow missing from the data.
 */
export function conflictingResourceIds(
  resourceId: string,
  edges: ConflictEdge[],
): Set<string> {
  const result = new Set<string>([resourceId]);
  for (const edge of edges) {
    if (edge.resource_id === resourceId) result.add(edge.conflicts_with_id);
    if (edge.conflicts_with_id === resourceId) result.add(edge.resource_id);
  }
  return result;
}

export interface ActiveBooking {
  resource_id: string;
  starts_at: string;
  ends_at: string;
}

export interface ClosurePeriod {
  resource_id: string;
  starts_at: string;
  ends_at: string;
}

/**
 * Determine whether a requested booking for `resourceId` over the given window
 * conflicts with any existing active booking (confirmed OR pending approval),
 * taking the bidirectional conflict matrix into account.
 *
 * Returns the id of the first conflicting resource, or null if available.
 */
export function findBookingConflict(params: {
  resourceId: string;
  startsAt: string;
  endsAt: string;
  conflicts: ConflictEdge[];
  activeBookings: ActiveBooking[];
}): string | null {
  const blocked = conflictingResourceIds(params.resourceId, params.conflicts);
  for (const b of params.activeBookings) {
    if (!blocked.has(b.resource_id)) continue;
    if (intervalsOverlap(params.startsAt, params.endsAt, b.starts_at, b.ends_at)) {
      return b.resource_id;
    }
  }
  return null;
}

/**
 * Whether the requested window hits an administratively blocked closure for
 * the resource (or a conflicting resource — closures apply per resource only).
 */
export function hitsClosure(params: {
  resourceId: string;
  startsAt: string;
  endsAt: string;
  closures: ClosurePeriod[];
}): boolean {
  return params.closures.some(
    (c) =>
      c.resource_id === params.resourceId &&
      intervalsOverlap(params.startsAt, params.endsAt, c.starts_at, c.ends_at),
  );
}

export interface AvailabilityResult {
  available: boolean;
  reason?: 'conflict' | 'closure';
  conflictingResourceId?: string;
}

/**
 * Pure availability check combining the conflict matrix and closures.
 * Does NOT account for whether the resource is active — callers filter that.
 */
export function checkAvailability(params: {
  resourceId: string;
  startsAt: string;
  endsAt: string;
  conflicts: ConflictEdge[];
  activeBookings: ActiveBooking[];
  closures: ClosurePeriod[];
}): AvailabilityResult {
  if (hitsClosure(params)) {
    return { available: false, reason: 'closure' };
  }
  const conflict = findBookingConflict(params);
  if (conflict) {
    return { available: false, reason: 'conflict', conflictingResourceId: conflict };
  }
  return { available: true };
}
