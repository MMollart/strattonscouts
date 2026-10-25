import type { Env } from './http';
import { ANCESTORS_SQL, DESCENDANTS_SQL, activeBookingSql, NOW_SQL } from './availability-sql';
import { ancestorIds } from '@shared/hierarchy';

/**
 * Check a resource's new parent before saving it. Returns an error message,
 * or null when the parent is fine. `resourceId` is null for a new resource.
 *
 * A parent must exist and must not be the resource itself or anything below
 * it (that would make a loop). When an existing resource moves under a new
 * parent, the two sides must not already hold overlapping upcoming bookings:
 * after the move they would block each other, so one of them would be a
 * double booking.
 */
export async function checkParent(env: Env, resourceId: string | null, parentId: string | null): Promise<string | null> {
  if (!parentId) return null;
  const parent = await env.DB.prepare('SELECT id, name FROM resources WHERE id = ?').bind(parentId).first<{ id: string; name: string }>();
  if (!parent) return 'The chosen parent resource does not exist.';
  if (!resourceId) return null;
  if (parentId === resourceId) return 'A resource cannot be part of itself.';

  const below = await env.DB.prepare(DESCENDANTS_SQL).bind(resourceId).all<{ resource_id: string }>();
  if (below.results.some((r) => r.resource_id === parentId)) {
    return `${parent.name} is already part of this resource, so it cannot also be its parent.`;
  }

  const clash = await env.DB.prepare(
    `SELECT a.reference AS a_ref, ra.name AS a_name, b.reference AS b_ref, rb.name AS b_name
     FROM bookings a JOIN booking_resources bra ON bra.booking_id = a.id
     JOIN bookings b ON a.starts_at < b.ends_at AND a.ends_at > b.starts_at AND b.id <> a.id
     JOIN booking_resources brb ON brb.booking_id = b.id
     JOIN resources ra ON ra.id = bra.resource_id
     JOIN resources rb ON rb.id = brb.resource_id
     WHERE ${activeBookingSql('a')} AND ${activeBookingSql('b')}
       AND a.ends_at > ${NOW_SQL}
       AND (bra.resource_id = ? OR bra.resource_id IN (${DESCENDANTS_SQL}))
       AND (brb.resource_id = ? OR brb.resource_id IN (${ANCESTORS_SQL}))
     LIMIT 1`,
  )
    .bind(resourceId, resourceId, parentId, parentId)
    .first<{ a_ref: string; a_name: string; b_ref: string; b_name: string }>();
  if (clash) {
    return `${clash.a_name} (${clash.a_ref}) and ${clash.b_name} (${clash.b_ref}) are booked at overlapping times. Move or cancel one of them before making this resource part of ${parent.name}.`;
  }
  return null;
}

/** Every resource's ancestors, worked out from the whole table so inactive groups still count. */
export async function loadAncestorMap(env: Env): Promise<Map<string, string[]>> {
  const rows = await env.DB.prepare('SELECT id, parent_id FROM resources').all<{ id: string; parent_id: string | null }>();
  return new Map(rows.results.map((r) => [r.id, ancestorIds(r.id, rows.results)]));
}
