import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { saveTemplate } from '../../../_lib/agreement-admin';
import { agreementTemplateSchema } from '@shared/validation';

// Admin: one agreement with its full version history.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const id = String(params.id);
  const t = await env.DB.prepare('SELECT * FROM agreement_templates WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!t) return error('Agreement not found', 404);
  const [versions, resources] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT v.id, v.version_number, v.title, v.body, v.effective_from, v.change_note, v.pdf_name, v.pdf_key IS NOT NULL AS has_pdf, v.content_hash,
              v.created_at, u.full_name AS created_by_name,
              (SELECT COUNT(*) FROM agreement_acceptances a WHERE a.version_id = v.id) AS acceptance_count
       FROM agreement_versions v LEFT JOIN users u ON u.id = v.created_by
       WHERE v.template_id = ? ORDER BY v.version_number DESC`,
    ).bind(id),
    env.DB.prepare('SELECT resource_id FROM resource_agreements WHERE template_id = ?').bind(id),
  ]);
  return json({
    ...t,
    applies_to_all: !!t.applies_to_all,
    is_active: !!t.is_active,
    resource_ids: resources.results.map((r) => r.resource_id),
    versions: versions.results.map((v) => ({ ...v, has_pdf: !!v.has_pdf })),
  });
};

export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'agreements.manage');
  if (user instanceof Response) return user;
  const id = String(params.id);
  if (!(await env.DB.prepare('SELECT 1 FROM agreement_templates WHERE id = ?').bind(id).first())) return error('Agreement not found', 404);
  const input = await parseBody(request, agreementTemplateSchema);
  if (input instanceof Response) return input;
  return saveTemplate(env, user, input, id);
};
