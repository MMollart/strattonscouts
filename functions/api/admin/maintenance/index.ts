import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { canonicalIso } from '../../../_lib/availability-sql';
import { saveMaintenance } from '../../../_lib/maintenance-save';
import { MAINTENANCE_SELECT } from '../../../_lib/maintenance';
import { MAINTENANCE_STATUSES, maintenanceSchema } from '@shared/validation';

/**
 * Admin: maintenance records (FR22 §4.8). Filters: resource_id, type_id,
 * status (comma-separated), from/to (ISO; overlapping the period).
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const url = new URL(request.url);
  const where: string[] = [];
  const binds: unknown[] = [];
  const resourceId = url.searchParams.get('resource_id');
  if (resourceId) {
    where.push('m.resource_id = ?');
    binds.push(resourceId);
  }
  const typeId = url.searchParams.get('type_id');
  if (typeId) {
    where.push('m.maintenance_type_id = ?');
    binds.push(typeId);
  }
  const statuses = url.searchParams.get('status')?.split(',').filter(Boolean) ?? [];
  if (statuses.length) {
    if (statuses.some((s) => !(MAINTENANCE_STATUSES as readonly string[]).includes(s))) return error('Unknown status', 400);
    where.push(`m.status IN (${statuses.map(() => '?').join(', ')})`);
    binds.push(...statuses);
  }
  for (const [param, sql] of [['from', 'm.ends_at > ?'], ['to', 'm.starts_at < ?']] as const) {
    const v = url.searchParams.get(param);
    if (v) {
      if (Number.isNaN(Date.parse(v))) return error(`${param} must be an ISO date-time`, 400);
      where.push(sql);
      binds.push(canonicalIso(v));
    }
  }
  const rows = await env.DB.prepare(`${MAINTENANCE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.starts_at DESC LIMIT 1000`)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({ ...r, blocks_availability: !!r.blocks_availability })));
};

// Admin: schedule maintenance.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'maintenance.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, maintenanceSchema);
  if (input instanceof Response) return input;
  return saveMaintenance(env, user, input, null);
};
