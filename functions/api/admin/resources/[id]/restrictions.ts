import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { restrictionsSchema } from '@shared/validation';

// Admin: a resource's minimum notice, maximum advance booking window (FR03)
// and provisional hold period (FR04; omitted keeps the current value).
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'availability.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, restrictionsSchema);
  if (input instanceof Response) return input;
  const setExpiry = input.provisional_expiry_hours !== undefined;
  const res = await env.DB.prepare(
    `UPDATE resources SET min_notice_minutes = ?, max_advance_days = ?,
            provisional_expiry_hours = CASE WHEN ? THEN ? ELSE provisional_expiry_hours END, updated_at = ?
     WHERE id = ?`,
  )
    .bind(input.min_notice_minutes || null, input.max_advance_days, setExpiry ? 1 : 0, input.provisional_expiry_hours ?? null, now(), String(params.id))
    .run();
  if (res.meta.changes !== 1) return error('Resource not found', 404);
  return json({ ok: true });
};
