import type { Env } from '../_lib/http';
import { error, json } from '../_lib/http';
import { loadActiveBookingsForResource } from '../_lib/booking';
import { checkAvailability } from '@shared/availability';
import type { ConflictEdge } from '@shared/availability';
import { conflictingResourceIds } from '@shared/availability';

/**
 * Public availability check. Returns only availability information — never
 * other customers' personal data or booking details.
 *
 * Query params: resource_id, starts_at (ISO), ends_at (ISO)
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const resourceId = url.searchParams.get('resource_id');
  const startsAt = url.searchParams.get('starts_at');
  const endsAt = url.searchParams.get('ends_at');

  if (!resourceId || !startsAt || !endsAt) {
    return error('resource_id, starts_at and ends_at are required', 400);
  }
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    return error('ends_at must be after starts_at', 400);
  }

  const resource = await env.DB.prepare('SELECT id, is_active FROM resources WHERE id = ?')
    .bind(resourceId)
    .first<{ id: string; is_active: number }>();
  if (!resource) return error('Resource not found', 404);
  if (!resource.is_active) return json({ available: false, reason: 'inactive' });

  const edgeRows = await env.DB.prepare(
    'SELECT resource_id, conflicts_with_id FROM resource_conflicts WHERE resource_id = ? OR conflicts_with_id = ?',
  )
    .bind(resourceId, resourceId)
    .all<ConflictEdge>();

  const blocked = Array.from(conflictingResourceIds(resourceId, edgeRows.results));
  const placeholders = blocked.map(() => '?').join(', ');
  const closureRows = await env.DB.prepare(
    `SELECT resource_id, starts_at, ends_at FROM resource_closures WHERE resource_id IN (${placeholders})`,
  )
    .bind(...blocked)
    .all<{ resource_id: string; starts_at: string; ends_at: string }>();

  const activeBookings = await loadActiveBookingsForResource(env, resourceId);

  const result = checkAvailability({
    resourceId,
    startsAt,
    endsAt,
    conflicts: edgeRows.results,
    activeBookings,
    closures: closureRows.results,
  });

  return json(result);
};
