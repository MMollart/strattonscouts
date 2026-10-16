import type { Env } from '../../../_lib/http';
import { json, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { saveTemplate } from '../../../_lib/agreement-admin';
import { agreementTemplateSchema } from '@shared/validation';

// Admin: agreement templates with their current version and assignments (FR20).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const ts = now();
  const [templates, assignments] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT t.id, t.title, t.summary, t.applies_to_all, t.is_active, t.updated_at,
              (SELECT COUNT(*) FROM agreement_versions v WHERE v.template_id = t.id) AS version_count,
              (SELECT v.version_number FROM agreement_versions v WHERE v.template_id = t.id AND v.effective_from <= ?
                ORDER BY v.effective_from DESC, v.version_number DESC LIMIT 1) AS current_version,
              (SELECT MIN(v.effective_from) FROM agreement_versions v WHERE v.template_id = t.id AND v.effective_from > ?) AS next_effective_from,
              (SELECT COUNT(*) FROM agreement_acceptances a WHERE a.template_id = t.id) AS acceptance_count
       FROM agreement_templates t ORDER BY t.is_active DESC, t.title`,
    ).bind(ts, ts),
    env.DB.prepare('SELECT template_id, resource_id FROM resource_agreements'),
  ]);
  const byTemplate = new Map<string, string[]>();
  for (const a of assignments.results as { template_id: string; resource_id: string }[]) {
    byTemplate.set(a.template_id, [...(byTemplate.get(a.template_id) ?? []), a.resource_id]);
  }
  return json(
    templates.results.map((t) => ({
      ...t,
      applies_to_all: !!t.applies_to_all,
      is_active: !!t.is_active,
      resource_ids: byTemplate.get(t.id as string) ?? [],
    })),
  );
};

export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'agreements.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, agreementTemplateSchema);
  if (input instanceof Response) return input;
  return saveTemplate(env, user, input, null);
};
