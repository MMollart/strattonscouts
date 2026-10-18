import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { auditStatement } from '../../../../_lib/audit';
import { memberAddSchema } from '@shared/validation';

// Administrators: add someone who already has an account straight away,
// without an invitation (Organisation Managers invite people instead).
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'bookings.manage');
  if (user instanceof Response) return user;
  const id = String(params.id);
  const input = await parseBody(request, memberAddSchema);
  if (input instanceof Response) return input;

  const [org, member] = await Promise.all([
    env.DB.prepare('SELECT id FROM organisations WHERE id = ?').bind(id).first(),
    env.DB.prepare('SELECT id, full_name FROM users WHERE email = ?').bind(input.email.toLowerCase()).first<{ id: string; full_name: string }>(),
  ]);
  if (!org) return error('Organisation not found', 404);
  if (!member) return error('Nobody has registered with that email address yet. Send them an invitation instead.', 404, { code: 'no_account' });

  const ts = now();
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO organisation_memberships (organisation_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(id, member.id, input.role, ts, ts),
    auditStatement(
      env,
      {
        actor: user,
        action: 'organisation.member_added',
        entityType: 'organisation_membership',
        entityId: `${id}:${member.id}`,
        entityLabel: member.full_name,
        after: { user_id: member.id, role: input.role },
        organisationId: id,
      },
      { onlyIfChanged: true },
    ),
  ]);
  if (inserted.meta.changes !== 1) return error('That person is already a member', 409, { code: 'already_member' });
  return json({ ok: true }, 201);
};
