import type { Env } from '../../../_lib/http';
import { error, json, newId, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { audited } from '../../../_lib/audit';
import { isUniqueViolation } from '../../../_lib/assets';
import { maintenanceTypeSchema } from '@shared/validation';

// Admin: maintenance types (FR22 §4.3), including retired ones.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare('SELECT id, label, sort_order, is_active FROM maintenance_types ORDER BY sort_order, label').all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({ ...r, is_active: !!r.is_active })));
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'maintenance.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, maintenanceTypeSchema);
  if (input instanceof Response) return input;
  const id = newId('mtype');
  const ts = now();
  try {
    await audited(env, { actor: user, action: 'maintenance.type_created', table: 'maintenance_types', id }, () =>
      env.DB.prepare('INSERT INTO maintenance_types (id, label, sort_order, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, input.label, input.sort_order, input.is_active ? 1 : 0, ts, ts)
        .run());
  } catch (e) {
    if (isUniqueViolation(e)) return error('A maintenance type with this name already exists', 409);
    throw e;
  }
  return json({ id }, 201);
};
