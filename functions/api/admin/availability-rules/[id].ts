import type { Env } from '../../../_lib/http';
import { error, json, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { availabilityRuleSchema } from '@shared/validation';

// Admin: edit a rule. Existing bookings are never changed by rule edits.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'availability.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, availabilityRuleSchema);
  if (input instanceof Response) return input;
  const res = await env.DB.prepare(
    `UPDATE availability_rules SET resource_id = ?, rule_type = ?, days_of_week = ?, start_time = ?, end_time = ?, valid_from = ?, valid_to = ?,
            label = ?, is_active = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
  )
    .bind(
      input.resource_id, input.rule_type, [...new Set(input.days_of_week)].sort().join(','), input.start_time, input.end_time,
      input.valid_from ?? null, input.valid_to ?? null, input.label ?? null, input.is_active ? 1 : 0, now(), user.id, String(params.id),
    )
    .run();
  if (res.meta.changes !== 1) return error('Rule not found', 404);
  return json({ ok: true });
};

export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'availability.manage');
  if (user instanceof Response) return user;
  await env.DB.prepare('DELETE FROM availability_rules WHERE id = ?').bind(String(params.id)).run();
  return json({ ok: true });
};
