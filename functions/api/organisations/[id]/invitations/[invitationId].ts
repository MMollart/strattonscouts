import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { getAuthUser } from '../../../../_lib/auth';
import { getMembershipRole } from '../../../../_lib/organisations';

// Organisation Managers: revoke a pending invitation.
export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);
  if ((await getMembershipRole(env, id, user.id)) !== 'manager') return error('Only an Organisation Manager can do this', 403);
  const res = await env.DB.prepare(
    `UPDATE organisation_invitations SET status = 'revoked', responded_at = ?, responded_by = ?
     WHERE id = ? AND organisation_id = ? AND status = 'pending'`,
  )
    .bind(now(), user.id, String(params.invitationId), id)
    .run();
  if (res.meta.changes !== 1) return error('Invitation is not pending', 409);
  return json({ ok: true });
};
