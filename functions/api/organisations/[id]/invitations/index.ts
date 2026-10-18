import type { Env } from '../../../../_lib/http';
import { error, json } from '../../../../_lib/http';
import { getAuthUser, rateLimit } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { inviteToOrganisation, organisationAccess } from '../../../../_lib/organisations';
import { invitationCreateSchema } from '@shared/validation';

// Organisation Managers and administrators: invite someone by email.
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);
  if (!(await organisationAccess(env, id, user)).canManage) return error('Only an Organisation Manager or an administrator can invite members', 403);
  const input = await parseBody(request, invitationCreateSchema);
  if (input instanceof Response) return input;
  if (!(await rateLimit(env, `${user.id}:${id}`, 'org_invite', 30, 60 * 60 * 1000))) {
    return error('Too many invitations, please try again later', 429);
  }
  const result = await inviteToOrganisation(env, { organisationId: id, email: input.email, role: input.role, invitedBy: user });
  if (!result.ok) {
    return error(
      result.code === 'already_member' ? 'That person is already a member' : 'That person already has an active invitation',
      409,
      { code: result.code },
    );
  }
  return json({ id: result.invitationId }, 201);
};
