import type { Env } from '../../_lib/http';
import { error, json, newId, now } from '../../_lib/http';
import { getAuthUser } from '../../_lib/auth';
import { encryptAtRest } from '../../_lib/crypto';
import { parseBody } from '../../_lib/request';
import { organisationSchema } from '@shared/validation';
import { auditStatement } from '../../_lib/audit';

// The signed-in user's organisations and their role in each.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const rows = await env.DB.prepare(
    `SELECT o.id, o.name, o.organisation_type_id, t.label AS organisation_type, o.pricing_category_id,
            pc.label AS category_label, m.role,
            (SELECT COUNT(*) FROM organisation_memberships x WHERE x.organisation_id = o.id) AS member_count
     FROM organisation_memberships m
     JOIN organisations o ON o.id = m.organisation_id
     JOIN organisation_types t ON t.id = o.organisation_type_id
     JOIN pricing_categories pc ON pc.id = o.pricing_category_id
     WHERE m.user_id = ? ORDER BY o.name`,
  )
    .bind(user.id)
    .all();
  return json(rows.results);
};

// Create an organisation; the creator becomes its first Organisation Manager.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const input = await parseBody(request, organisationSchema);
  if (input instanceof Response) return input;

  const [type, cat] = await env.DB.batch([
    env.DB.prepare('SELECT id FROM organisation_types WHERE id = ?').bind(input.organisation_type_id),
    env.DB.prepare('SELECT id FROM pricing_categories WHERE id = ?').bind(input.pricing_category_id),
  ]);
  if (!type.results.length) return error('Invalid organisation type', 400);
  if (!cat.results.length) return error('Invalid pricing category', 400);

  const id = newId('org');
  const ts = now();
  const phone = await encryptAtRest(input.contact_phone, env.DATA_ENCRYPTION_KEY ?? '');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organisations (id, name, organisation_type_id, pricing_category_id, contact_email, contact_phone_encrypted, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, input.name, input.organisation_type_id, input.pricing_category_id, input.contact_email.toLowerCase(), phone, user.id, ts, ts),
    env.DB.prepare(
      `INSERT INTO organisation_memberships (organisation_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'manager', ?, ?)`,
    ).bind(id, user.id, ts, ts),
    auditStatement(env, {
      actor: user,
      action: 'organisation.created',
      entityType: 'organisation',
      entityId: id,
      entityLabel: input.name,
      after: { name: input.name, organisation_type_id: input.organisation_type_id, pricing_category_id: input.pricing_category_id, manager_user_id: user.id },
      organisationId: id,
    }),
  ]);
  return json({ id }, 201);
};
