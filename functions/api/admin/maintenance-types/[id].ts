import type { Env } from '../../../_lib/http';
import { error, json, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { audited } from '../../../_lib/audit';
import { isUniqueViolation } from '../../../_lib/assets';
import { maintenanceTypeSchema } from '@shared/validation';

// Admin: rename, reorder or retire a maintenance type. Retired types stay on their records.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'maintenance.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, maintenanceTypeSchema);
  if (input instanceof Response) return input;
  const id = String(params.id);
  try {
    const res = await audited(env, { actor: user, action: 'maintenance.type_updated', table: 'maintenance_types', id }, () =>
      env.DB.prepare('UPDATE maintenance_types SET label = ?, sort_order = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .bind(input.label, input.sort_order, input.is_active ? 1 : 0, now(), id)
        .run());
    if (res.meta.changes !== 1) return error('Maintenance type not found', 404);
  } catch (e) {
    if (isUniqueViolation(e)) return error('A maintenance type with this name already exists', 409);
    throw e;
  }
  return json({ ok: true });
};
