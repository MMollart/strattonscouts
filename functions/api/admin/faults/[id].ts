import type { Env } from '../../../_lib/http';
import { error } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { saveFault } from '../../../_lib/fault-save';
import { faultSchema } from '@shared/validation';

// Admin: update a fault's details, severity or status. Faults are never deleted.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'maintenance.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, faultSchema);
  if (input instanceof Response) return input;
  const existing = await env.DB.prepare('SELECT id, reference, reported_at, reported_by, resolved_at FROM resource_faults WHERE id = ?')
    .bind(String(params.id))
    .first<{ id: string; reference: string; reported_at: string; reported_by: string; resolved_at: string | null }>();
  if (!existing) return error('Fault not found', 404);
  return saveFault(env, user, input, existing);
};
