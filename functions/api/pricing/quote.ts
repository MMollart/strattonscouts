import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { can, getAuthUser } from '../../_lib/auth';
import { parseBody } from '../../_lib/request';
import { canonicalIso } from '../../_lib/availability-sql';
import { quotePrice } from '../../_lib/pricing-engine';
import { getMembershipRole } from '../../_lib/organisations';
import { quoteSchema } from '@shared/validation';

/**
 * Price a prospective booking server-side so the customer sees the exact total
 * (and breakdown) before submitting. The same function prices the booking.
 */
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const input = await parseBody(request, quoteSchema);
  if (input instanceof Response) return input;

  let customerId = user.id;
  if (input.on_behalf_of_user_id) {
    if (!can(user, 'bookings.create')) return error('Not authorised', 403);
    customerId = input.on_behalf_of_user_id;
  }
  if (input.organisation_id && !(await getMembershipRole(env, input.organisation_id, customerId))) {
    return error('You can only book on behalf of an organisation you belong to', 403);
  }
  const quote = await quotePrice(env, {
    resourceId: input.resource_id,
    userId: customerId,
    organisationId: input.organisation_id,
    startsAt: canonicalIso(input.starts_at),
    endsAt: canonicalIso(input.ends_at),
  });
  if (!quote.ok) return error(quote.message, quote.code === 'not_found' ? 404 : 400, { code: quote.code });
  return json({ category_id: quote.categoryId, ...quote.breakdown });
};
