import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { getAuthUser } from '../../../../_lib/auth';
import { organisationAccess } from '../../../../_lib/organisations';
import { auditStatement } from '../../../../_lib/audit';

// Organisation Managers and administrators: revoke a pending invitation.
export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);
  if (!(await organisationAccess(env, id, user)).canManage) return error('Only an Organisation Manager or an administrator can do this', 403);
  const [res] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE organisation_invitations SET status = 'revoked', responded_at = ?, responded_by = ?
       WHERE id = ? AND organisation_id = ? AND status = 'pending'`,
    ).bind(now(), user.id, String(params.invitationId), id),
    auditStatement(
      env,
      { actor: user, action: 'organisation.invitation_revoked', entityType: 'organisation_invitation', entityId: String(params.invitationId), after: { status: 'revoked' }, organisationId: id },
      { onlyIfChanged: true },
    ),
  ]);
  if (res.meta.changes !== 1) return error('Invitation is not pending', 409);
  return json({ ok: true });
};
