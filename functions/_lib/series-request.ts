import type { Env } from './http';
import { error } from './http';
import { can, type AuthUser } from './auth';
import { getMembershipRole } from './organisations';
import type { RecurrenceInput } from '@shared/validation';
import type { SeriesRequest } from './recurring';

/**
 * Who a series is for, with the same rules as a single booking: admins with
 * bookings.create may book for a customer, and an organisation series needs
 * the customer to be a member.
 */
export async function resolveSeriesRequest(env: Env, user: AuthUser, input: RecurrenceInput): Promise<SeriesRequest | Response> {
  let userId = user.id;
  if (input.on_behalf_of_user_id) {
    if (!can(user, 'bookings.create')) return error('Not authorised', 403);
    userId = input.on_behalf_of_user_id;
  }
  const organisationId = input.organisation_id ?? null;
  if (organisationId && !(await getMembershipRole(env, organisationId, userId))) {
    return error('You can only book on behalf of an organisation you belong to', 403);
  }
  return {
    userId,
    actorId: user.id,
    resourceId: input.resource_id,
    organisationId,
    pattern: {
      frequency: input.frequency,
      monthlyMode: input.monthly_mode,
      startDate: input.start_date,
      startTime: input.start_time,
      endTime: input.end_time,
      untilDate: input.until_date ?? null,
      count: input.count ?? null,
    },
  };
}
