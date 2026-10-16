import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { FAULT_SELECT, saveFault } from '../../../_lib/fault-save';
import { FAULT_SEVERITIES, FAULT_STATUSES, faultSchema } from '@shared/validation';

// Admin: reported faults. Filters: resource_id, status (comma-separated), severity.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const url = new URL(request.url);
  const where: string[] = [];
  const binds: unknown[] = [];
  const resourceId = url.searchParams.get('resource_id');
  if (resourceId) {
    where.push('f.resource_id = ?');
    binds.push(resourceId);
  }
  const statuses = url.searchParams.get('status')?.split(',').filter(Boolean) ?? [];
  if (statuses.length) {
    if (statuses.some((s) => !(FAULT_STATUSES as readonly string[]).includes(s))) return error('Unknown status', 400);
    where.push(`f.status IN (${statuses.map(() => '?').join(', ')})`);
    binds.push(...statuses);
  }
  const severity = url.searchParams.get('severity');
  if (severity) {
    if (!(FAULT_SEVERITIES as readonly string[]).includes(severity)) return error('Unknown severity', 400);
    where.push('f.severity = ?');
    binds.push(severity);
  }
  const rows = await env.DB.prepare(
    `${FAULT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE WHEN f.status IN ('open', 'in_progress') THEN 0 ELSE 1 END,
              CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, f.reported_at DESC LIMIT 1000`,
  )
    .bind(...binds)
    .all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({ ...r, blocks_bookings: !!r.blocks_bookings })));
};

// Admin: report a fault.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'maintenance.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, faultSchema);
  if (input instanceof Response) return input;
  return saveFault(env, user, input, null);
};
