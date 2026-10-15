import type { Env } from '../_lib/http';
import { error, json } from '../_lib/http';
import { canonicalIso, loadBusyPeriods } from '../_lib/availability-sql';

const MAX_RANGE_MS = 1000 * 60 * 60 * 24 * 62; // a little over two months

/**
 * Public calendar feed: the periods in [from, to) when a resource cannot be
 * booked, either because of an active booking (on it or a conflicting
 * resource) or an administrative closure. Returns times and a kind only —
 * never who booked or any booking details.
 *
 * Query params: resource_id, from (ISO), to (ISO)
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const resourceId = url.searchParams.get('resource_id');
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  if (!resourceId || !fromRaw || !toRaw) return error('resource_id, from and to are required', 400);
  if (Number.isNaN(Date.parse(fromRaw)) || Number.isNaN(Date.parse(toRaw))) {
    return error('from and to must be ISO-8601 date-times', 400);
  }
  const from = canonicalIso(fromRaw);
  const to = canonicalIso(toRaw);
  if (to <= from) return error('to must be after from', 400);
  if (Date.parse(to) - Date.parse(from) > MAX_RANGE_MS) return error('Range is too long', 400);

  const resource = await env.DB.prepare('SELECT id, is_active FROM resources WHERE id = ?')
    .bind(resourceId)
    .first<{ id: string; is_active: number }>();
  if (!resource) return error('Resource not found', 404);
  if (!resource.is_active) return json({ active: false, busy: [] });

  const busy = await loadBusyPeriods(env, resourceId, from, to);
  return json({ active: true, busy });
};
