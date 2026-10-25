import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { saveMaintenance } from '../../../_lib/maintenance-save';
import { MAINTENANCE_SELECT, findAffectedBookings, maintenanceBlocks } from '../../../_lib/maintenance';
import { maintenanceSchema } from '@shared/validation';
import { resourceNamesSql } from '../../../_lib/availability-sql';

// Admin: one maintenance record with the bookings it affects.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const id = String(params.id);
  const m = await env.DB.prepare(`${MAINTENANCE_SELECT} WHERE m.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!m) return error('Maintenance record not found', 404);
  const recorded = await env.DB.prepare(
    `SELECT x.booking_id, x.status AS action_status, x.resolution_note, x.notified_at, b.reference, b.status, b.starts_at, b.ends_at,
            ${resourceNamesSql('b')} AS resource_name, u.full_name AS customer_name
     FROM maintenance_affected_bookings x JOIN bookings b ON b.id = x.booking_id JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
     WHERE x.maintenance_id = ? ORDER BY b.starts_at`,
  )
    .bind(id)
    .all();
  // Bookings overlapping it now (for non-blocking maintenance too), so an admin can see the impact.
  const overlapping = await findAffectedBookings(env, m.resource_id as string, m.starts_at as string, m.ends_at as string);
  return json({
    ...m,
    blocks_availability: !!m.blocks_availability,
    is_blocking: maintenanceBlocks(m as { status: string; blocks_availability: number }),
    affected_bookings: recorded.results,
    overlapping_bookings: overlapping,
  });
};

// Admin: edit, start, complete or cancel maintenance. Records are never deleted.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'maintenance.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, maintenanceSchema);
  if (input instanceof Response) return input;
  const existing = await env.DB.prepare('SELECT id, reference, maintenance_type_id, created_by, created_at FROM maintenance_records WHERE id = ?')
    .bind(String(params.id))
    .first<{ id: string; reference: string; maintenance_type_id: string; created_by: string; created_at: string }>();
  if (!existing) return error('Maintenance record not found', 404);
  return saveMaintenance(env, user, input, existing);
};
