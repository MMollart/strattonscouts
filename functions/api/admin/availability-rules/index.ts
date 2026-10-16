import type { Env } from '../../../_lib/http';
import { error, json, newId, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { exists } from '../../../_lib/crud';
import { availabilityRuleSchema } from '@shared/validation';
import { audited } from '../../../_lib/audit';

// Admin: recurring availability rules, optionally for one resource.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const resourceId = new URL(request.url).searchParams.get('resource_id');
  const rows = await env.DB.prepare(
    `SELECT ar.*, r.name AS resource_name FROM availability_rules ar JOIN resources r ON r.id = ar.resource_id
     ${resourceId ? 'WHERE ar.resource_id = ?' : ''} ORDER BY r.name, ar.rule_type, ar.start_time`,
  )
    .bind(...(resourceId ? [resourceId] : []))
    .all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({ ...r, is_active: !!r.is_active })));
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'availability.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, availabilityRuleSchema);
  if (input instanceof Response) return input;
  if (!(await exists(env, 'resources', input.resource_id))) return error('Resource not found', 400);
  const id = newId('avr');
  const ts = now();
  await audited(env, { actor: user, action: 'availability.rule_created', table: 'availability_rules', id }, () =>
    env.DB.prepare(
      `INSERT INTO availability_rules (id, resource_id, rule_type, days_of_week, start_time, end_time, valid_from, valid_to, label, is_active, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id, input.resource_id, input.rule_type, [...new Set(input.days_of_week)].sort().join(','), input.start_time, input.end_time,
        input.valid_from ?? null, input.valid_to ?? null, input.label ?? null, input.is_active ? 1 : 0, ts, ts, user.id,
      )
      .run());
  return json({ id }, 201);
};
