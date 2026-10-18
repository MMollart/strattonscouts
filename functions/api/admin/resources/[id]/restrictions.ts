import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { restrictionsSchema } from '@shared/validation';
import { audited } from '../../../../_lib/audit';

// Admin: a resource's minimum notice, maximum advance booking window (FR03),
// provisional hold period (FR04) and booking length rules with the usual
// arrival and departure times. Fields after the first two may be omitted to
// keep their current values.
const OPTIONAL = ['provisional_expiry_hours', 'min_duration_minutes', 'max_duration_minutes', 'min_nights', 'max_nights', 'default_start_time', 'default_end_time'] as const;

export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'availability.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, restrictionsSchema);
  if (input instanceof Response) return input;
  const given = OPTIONAL.filter((k) => input[k] !== undefined);
  const res = await audited(env, { actor: user, action: 'resource.restrictions_updated', table: 'resources', id: String(params.id) }, () =>
    env.DB.prepare(
      `UPDATE resources SET min_notice_minutes = ?, max_advance_days = ?, ${given.map((k) => `${k} = ?, `).join('')}updated_at = ?
       WHERE id = ?`,
    )
      .bind(input.min_notice_minutes || null, input.max_advance_days, ...given.map((k) => input[k] ?? null), now(), String(params.id))
      .run());
  if (res.meta.changes !== 1) return error('Resource not found', 404);
  return json({ ok: true });
};
