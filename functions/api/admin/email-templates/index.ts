import type { Env } from '../../../_lib/http';
import { json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { PARAM_DESCRIPTION, TEMPLATE_DEFINITIONS, templateParams } from '@shared/email-templates';

// Admin: every email template with its current content and available parameters.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'email_templates.manage');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare('SELECT key, subject, body_text, body_html, is_enabled, updated_at FROM email_templates').all<{
    key: string; subject: string; body_text: string; body_html: string | null; is_enabled: number; updated_at: string;
  }>();
  const saved = new Map(rows.results.map((r) => [r.key, r]));
  return json(
    TEMPLATE_DEFINITIONS.map((d) => {
      const row = saved.get(d.key);
      return {
        key: d.key,
        name: d.name,
        trigger: d.trigger,
        required: !!d.required,
        customised: !!row,
        subject: row?.subject ?? d.subject,
        body_text: row?.body_text ?? d.body_text,
        body_html: row?.body_html ?? null,
        is_enabled: d.required ? true : row ? !!row.is_enabled : true,
        updated_at: row?.updated_at ?? null,
        default_subject: d.subject,
        default_body_text: d.body_text,
        parameters: templateParams(d.key).map((p) => ({ name: p, description: PARAM_DESCRIPTION[p] ?? '' })),
      };
    }),
  );
};
