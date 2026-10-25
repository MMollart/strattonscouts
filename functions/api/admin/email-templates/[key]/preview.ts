import type { Env } from '../../../../_lib/http';
import { error, json } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { commonParams } from '../../../../_lib/email';
import { emailTestSchema } from '@shared/validation';
import { contentTexts, renderEmail, SAMPLE_PARAMS, sampleItems, templateDefinition, unknownParams } from '@shared/email-templates';

// Admin: render unsaved template content with example values.
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'email_templates.manage');
  if (user instanceof Response) return user;
  const def = templateDefinition(String(params.key));
  if (!def) return error('Template not found', 404);
  const input = await parseBody(request, emailTestSchema);
  if (input instanceof Response) return input;
  const values = { ...(await commonParams(env, SAMPLE_PARAMS.customer_email)), ...SAMPLE_PARAMS };
  return json({
    ...renderEmail({ ...input, badge: def.badge }, values, { showLogoPlaceholder: true, items: sampleItems(def.key) }),
    unknown: unknownParams(def.key, ...contentTexts(input)),
  });
};
