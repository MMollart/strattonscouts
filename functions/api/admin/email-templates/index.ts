import type { Env } from '../../../_lib/http';
import { json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { PARAM_DESCRIPTION, TEMPLATE_DEFINITIONS, templateParams, type EmailContent } from '@shared/email-templates';

// Admin: every email template with its current content and available parameters.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'email_templates.manage');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare('SELECT key, subject, title, body, detail_card, thanks, footer, is_enabled, updated_at FROM email_templates').all<
    EmailContent & { key: string; title: string | null; is_enabled: number; updated_at: string }
  >();
  const saved = new Map(rows.results.map((r) => [r.key, r]));
  return json(
    TEMPLATE_DEFINITIONS.map((d) => {
      const row = saved.get(d.key);
      // Rows saved before emails had sections only keep their on/off switch.
      const content = row?.title != null ? row : null;
      return {
        key: d.key,
        name: d.name,
        trigger: d.trigger,
        required: !!d.required,
        customised: !!content,
        subject: content?.subject ?? d.subject,
        title: content?.title ?? d.title,
        body: content?.body ?? d.body,
        detail_card: content ? content.detail_card ?? '' : d.detail_card,
        thanks: content ? content.thanks ?? '' : d.thanks,
        footer: content ? content.footer ?? '' : d.footer,
        is_enabled: d.required ? true : row ? !!row.is_enabled : true,
        updated_at: content?.updated_at ?? null,
        parameters: templateParams(d.key).map((p) => ({ name: p, description: PARAM_DESCRIPTION[p] ?? '' })),
      };
    }),
  );
};
