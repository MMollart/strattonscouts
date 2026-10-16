import type { Env } from '../../../_lib/http';
import { error, json, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { emailTemplateSchema } from '@shared/validation';
import { contentTexts, SECTION_KEYS, templateDefinition, unknownParams } from '@shared/email-templates';
import { audited } from '../../../_lib/audit';

// Admin: save a template. Unknown {{ parameters }} are refused so typos are caught.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'email_templates.manage');
  if (user instanceof Response) return user;
  const def = templateDefinition(String(params.key));
  if (!def) return error('Template not found', 404);
  const input = await parseBody(request, emailTemplateSchema);
  if (input instanceof Response) return input;
  const unknown = unknownParams(def.key, ...contentTexts(input));
  if (unknown.length) return error(`Unknown parameters: ${unknown.map((u) => `{{ ${u} }}`).join(', ')}`, 400, { code: 'unknown_params', unknown });
  if (def.required && !input.is_enabled) return error('This email is needed for sign-in and invitations, so it cannot be turned off', 400);
  // body_text keeps a plain-text copy of the sections; body_html is no longer used.
  const bodyText = SECTION_KEYS.map((k) => input[k]).filter(Boolean).join('\n\n');
  await audited(env, { actor: user, action: 'email_template.updated', table: 'email_templates', id: def.key }, () =>
    env.DB.prepare(
      `INSERT INTO email_templates (key, subject, title, body, detail_card, thanks, footer, body_text, body_html, is_enabled, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET subject = excluded.subject, title = excluded.title, body = excluded.body, detail_card = excluded.detail_card,
         thanks = excluded.thanks, footer = excluded.footer, body_text = excluded.body_text, body_html = NULL,
         is_enabled = excluded.is_enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
      .bind(def.key, input.subject, input.title, input.body, input.detail_card, input.thanks, input.footer, bodyText, input.is_enabled ? 1 : 0, now(), user.id)
      .run());
  return json({ ok: true });
};

// Admin: restore the default content (and enable the template).
export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'email_templates.manage');
  if (user instanceof Response) return user;
  if (!templateDefinition(String(params.key))) return error('Template not found', 404);
  await audited(env, { actor: user, action: 'email_template.reset', table: 'email_templates', id: String(params.key) }, () =>
    env.DB.prepare('DELETE FROM email_templates WHERE key = ?').bind(String(params.key)).run());
  return json({ ok: true });
};
