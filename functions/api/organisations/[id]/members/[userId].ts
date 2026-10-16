import type { Env } from '../../../../_lib/http';
import { error, json } from '../../../../_lib/http';
import { getAuthUser } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { changeMembership, getMembershipRole } from '../../../../_lib/organisations';
import { membershipUpdateSchema } from '@shared/validation';

function lastManager(): Response {
  return error('An organisation must always have at least one Organisation Manager', 409, { code: 'last_manager' });
}

// Organisation Managers: promote a member or remove management permissions.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);
  if ((await getMembershipRole(env, id, user.id)) !== 'manager') return error('Only an Organisation Manager can do this', 403);
  const input = await parseBody(request, membershipUpdateSchema);
  if (input instanceof Response) return input;
  const result = await changeMembership(env, { organisationId: id, userId: String(params.userId), role: input.role, actor: user });
  if (!result.ok) return result.code === 'not_member' ? error('Not a member', 404) : lastManager();
  return json({ ok: true });
};

// Organisation Managers remove members; any member may remove themselves (leave).
export const onRequestDelete: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);
  const target = String(params.userId);
  if (target !== user.id && (await getMembershipRole(env, id, user.id)) !== 'manager') {
    return error('Only an Organisation Manager can do this', 403);
  }
  const result = await changeMembership(env, { organisationId: id, userId: target, role: null, actor: user });
  if (!result.ok) return result.code === 'not_member' ? error('Not a member', 404) : lastManager();
  return json({ ok: true });
};
