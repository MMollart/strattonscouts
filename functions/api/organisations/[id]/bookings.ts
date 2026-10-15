import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { can, getAuthUser } from '../../../_lib/auth';
import { getMembershipRole } from '../../../_lib/organisations';
import { loadOrganisationBookings } from '../../../_lib/org-views';

// Bookings made on behalf of an organisation, for its members.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const id = String(params.id);
  if (!(await getMembershipRole(env, id, user.id)) && !can(user, 'bookings.view')) return error('Not authorised', 403);
  return json(await loadOrganisationBookings(env, id));
};
