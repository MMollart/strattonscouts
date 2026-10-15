import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { restrictionsSchema } from '@shared/validation';

// Admin: a resource's minimum notice and maximum advance booking window.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'availability.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, restrictionsSchema);
  if (input instanceof Response) return input;
  const res = await env.DB.prepare('UPDATE resources SET min_notice_minutes = ?, max_advance_days = ?, updated_at = ? WHERE id = ?')
    .bind(input.min_notice_minutes || null, input.max_advance_days, now(), String(params.id))
    .run();
  if (res.meta.changes !== 1) return error('Resource not found', 404);
  return json({ ok: true });
};
