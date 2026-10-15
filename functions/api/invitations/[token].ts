import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { clientIp, getAuthUser, rateLimit } from '../../_lib/auth';
import { parseBody } from '../../_lib/request';
import { findInvitation, respondToInvitation } from '../../_lib/organisations';
import { invitationResponseSchema } from '@shared/validation';

/**
 * Invitation landing page data. Anyone holding the link sees the organisation
 * and whether it is still valid; the invited address is only revealed to the
 * signed-in recipient, otherwise it is masked.
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  if (!(await rateLimit(env, clientIp(request), 'invitation_lookup', 60, 15 * 60 * 1000))) {
    return error('Too many requests, please try again later', 429);
  }
  const inv = await findInvitation(env, String(params.token));
  if (!inv) return error('This invitation link is not valid', 404);
  const user = await getAuthUser(env, request);
  const isRecipient = !!user && user.email.toLowerCase() === inv.email;
  const [local, domain] = inv.email.split('@');
  return json({
    organisation_name: inv.organisation_name,
    role: inv.role,
    status: inv.status,
    expires_at: inv.expires_at,
    email: isRecipient ? inv.email : `${local.slice(0, 1)}***@${domain}`,
    signed_in: !!user,
    is_recipient: isRecipient,
  });
};

// Accept or decline. Body: { action: 'accept' | 'decline' }
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Please sign in to respond to this invitation', 401);
  const input = await parseBody(request, invitationResponseSchema);
  if (input instanceof Response) return input;
  const result = await respondToInvitation(env, { token: String(params.token), user, action: input.action });
  if (!result.ok) {
    const map = {
      not_found: ['This invitation link is not valid', 404],
      wrong_recipient: ['This invitation was sent to a different email address. Sign in with that address to accept it.', 403],
      not_pending: ['This invitation has already been used, revoked or has expired', 409],
    } as const;
    const [message, status] = map[result.code];
    return error(message, status, { code: result.code });
  }
  return json({ ok: true, organisation_id: result.organisationId });
};
