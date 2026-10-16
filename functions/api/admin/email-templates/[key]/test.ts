import type { Env } from '../../../../_lib/http';
import { error, json } from '../../../../_lib/http';
import { rateLimit, requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { sendEmail } from '../../../../_lib/email';
import { emailTestSchema } from '@shared/validation';
import { contentTexts, SAMPLE_PARAMS, templateDefinition, unknownParams } from '@shared/email-templates';

// Admin: send the (unsaved) template with example values to yourself.
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'email_templates.manage');
  if (user instanceof Response) return user;
  const def = templateDefinition(String(params.key));
  if (!def) return error('Template not found', 404);
  const input = await parseBody(request, emailTestSchema);
  if (input instanceof Response) return input;
  const unknown = unknownParams(def.key, ...contentTexts(input));
  if (unknown.length) return error(`Unknown parameters: ${unknown.map((u) => `{{ ${u} }}`).join(', ')}`, 400, { code: 'unknown_params', unknown });
  if (!(await rateLimit(env, user.id, 'email_test', 10, 60 * 60 * 1000))) return error('Too many test emails. Try again later.', 429);
  const result = await sendEmail(env, {
    to: user.email,
    template: def.key,
    params: { ...SAMPLE_PARAMS, customer_name: user.full_name, customer_email: user.email },
    content: { ...input, subject: `[Test] ${input.subject}` },
  });
  return json({ ok: result.status === 'sent', status: result.status, to: user.email });
};
