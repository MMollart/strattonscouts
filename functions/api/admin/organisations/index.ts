import type { Env } from '../../../_lib/http';
import { error, json, newId, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { encryptAtRest } from '../../../_lib/crypto';
import { parseBody } from '../../../_lib/request';
import { auditStatement } from '../../../_lib/audit';
import { inviteToOrganisation } from '../../../_lib/organisations';
import { adminOrganisationCreateSchema } from '@shared/validation';

// Admin: search organisations. Query: q (name or contact email)
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const q = new URL(request.url).searchParams.get('q')?.trim();
  const rows = await env.DB.prepare(
    `SELECT o.id, o.name, t.label AS organisation_type, pc.label AS category_label, o.pricing_category_id, o.contact_email,
            (SELECT COUNT(*) FROM organisation_memberships m WHERE m.organisation_id = o.id) AS member_count,
            (SELECT COUNT(*) FROM bookings b WHERE b.organisation_id = o.id) AS booking_count
     FROM organisations o
     JOIN organisation_types t ON t.id = o.organisation_type_id
     JOIN pricing_categories pc ON pc.id = o.pricing_category_id
     ${q ? 'WHERE o.name LIKE ? OR o.contact_email LIKE ?' : ''}
     ORDER BY o.name LIMIT 500`,
  )
    .bind(...(q ? [`%${q}%`, `%${q}%`] : []))
    .all();
  return json(rows.results);
};

/**
 * Admin: create an organisation for a group. The named manager becomes its
 * Organisation Manager at once if they have an account; otherwise they are
 * emailed an invitation to manage it.
 */
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, adminOrganisationCreateSchema);
  if (input instanceof Response) return input;

  const [type, cat] = await env.DB.batch([
    env.DB.prepare('SELECT id FROM organisation_types WHERE id = ?').bind(input.organisation_type_id),
    env.DB.prepare('SELECT id FROM pricing_categories WHERE id = ?').bind(input.pricing_category_id),
  ]);
  if (!type.results.length) return error('Invalid organisation type', 400);
  if (!cat.results.length) return error('Invalid pricing category', 400);
  const manager = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(input.manager_email.toLowerCase())
    .first<{ id: string }>();

  const id = newId('org');
  const ts = now();
  const phone = await encryptAtRest(input.contact_phone, env.DATA_ENCRYPTION_KEY ?? '');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organisations (id, name, organisation_type_id, pricing_category_id, contact_email, contact_phone_encrypted, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, input.name, input.organisation_type_id, input.pricing_category_id, input.contact_email.toLowerCase(), phone, user.id, ts, ts),
    ...(manager
      ? [
          env.DB.prepare(
            `INSERT INTO organisation_memberships (organisation_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'manager', ?, ?)`,
          ).bind(id, manager.id, ts, ts),
        ]
      : []),
    auditStatement(env, {
      actor: user,
      action: 'organisation.created',
      entityType: 'organisation',
      entityId: id,
      entityLabel: input.name,
      after: { name: input.name, organisation_type_id: input.organisation_type_id, pricing_category_id: input.pricing_category_id, manager_user_id: manager?.id ?? null },
      organisationId: id,
    }),
  ]);
  if (!manager) {
    await inviteToOrganisation(env, { organisationId: id, email: input.manager_email, role: 'manager', invitedBy: user });
  }
  return json({ id, manager: manager ? 'added' : 'invited' }, 201);
};
