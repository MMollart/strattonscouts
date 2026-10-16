import type { Env } from '../../../../_lib/http';
import { error, json } from '../../../../_lib/http';
import { getAuthUser } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { checkAmendment } from '../../../../_lib/amendments';
import { acceptedVersionIds, publicAgreement, requiredAgreements } from '../../../../_lib/agreements';
import { amendmentRequestSchema } from '@shared/validation';

// Check a proposed change: availability and the new price with the difference.
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const input = await parseBody(request, amendmentRequestSchema);
  if (input instanceof Response) return input;
  const check = await checkAmendment(env, user, String(params.id), { resourceId: input.resource_id, startsAt: input.starts_at, endsAt: input.ends_at });
  if (!check.ok) return error(check.message, check.status, { code: check.code, problems: check.problems });
  const price = check.planned.price;
  const accepted = await acceptedVersionIds(env, check.booking.id);
  const needed = (await requiredAgreements(env, [check.planned.resourceId])).filter((r) => !accepted.has(r.version_id));
  return json({
    // Agreements to accept with this change: only ones the booking has not accepted (FR20).
    agreements_required: needed.map(publicAgreement),
    available: true,
    price,
    current_total_pence: check.booking.total_amount_pence,
    difference_pence: price.total_pence - check.booking.total_amount_pence,
  });
};
