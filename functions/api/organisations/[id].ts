import type { Env } from '../../_lib/http';
import { error, json, now } from '../../_lib/http';
import { can, getAuthUser } from '../../_lib/auth';
import { encryptAtRest } from '../../_lib/crypto';
import { parseBody } from '../../_lib/request';
import { organisationAccess } from '../../_lib/organisations';
import { loadOrganisation } from '../../_lib/org-views';
import { organisationSchema } from '@shared/validation';
import { audited } from '../../_lib/audit';

// Organisation details for its members (and administrators).
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);
  const { role, canManage } = await organisationAccess(env, id, user);
  if (!role && !can(user, 'bookings.view')) return error('Not authorised', 403);
  const org = await loadOrganisation(env, id, { includeInvitations: canManage });
  if (!org) return error('Organisation not found', 404);
  return json({ ...org, my_role: role, can_manage: canManage });
};

// Organisation Managers: update the organisation's details.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);
  if (!(await organisationAccess(env, id, user)).canManage) return error('Only an Organisation Manager or an administrator can do this', 403);
  const exists = await env.DB.prepare('SELECT 1 FROM organisations WHERE id = ?').bind(id).first();
  if (!exists) return error('Organisation not found', 404);
  const input = await parseBody(request, organisationSchema);
  if (input instanceof Response) return input;
  const [type, cat] = await env.DB.batch([
    env.DB.prepare('SELECT id FROM organisation_types WHERE id = ?').bind(input.organisation_type_id),
    env.DB.prepare('SELECT id FROM pricing_categories WHERE id = ?').bind(input.pricing_category_id),
  ]);
  if (!type.results.length) return error('Invalid organisation type', 400);
  if (!cat.results.length) return error('Invalid pricing category', 400);
  const phone = await encryptAtRest(input.contact_phone, env.DATA_ENCRYPTION_KEY ?? '');
  await audited(env, { actor: user, action: 'organisation.updated', table: 'organisations', id }, () =>
    env.DB.prepare(
      `UPDATE organisations SET name = ?, organisation_type_id = ?, pricing_category_id = ?, contact_email = ?, contact_phone_encrypted = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(input.name, input.organisation_type_id, input.pricing_category_id, input.contact_email.toLowerCase(), phone, now(), id)
      .run());
  return json({ ok: true });
};
