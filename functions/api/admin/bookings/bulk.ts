import type { Env } from '../../../_lib/http';
import { error, json, newId } from '../../../_lib/http';
import { getAuthUser, requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { transitionBooking, transitionErrorMessage } from '../../../_lib/lifecycle';
import { sendBookingEmails, type BookingEmail } from '../../../_lib/booking-emails';
import { bulkBookingActionSchema } from '@shared/validation';

const TARGET = { approve: 'confirmed', reject: 'rejected', cancel: 'cancelled' } as const;

/**
 * Admin: approve (or confirm a provisional hold), reject or cancel several
 * bookings at once. Each booking is checked and changed on its own, exactly
 * as one at a time, so one that cannot be changed does not stop the rest.
 * Each person then gets one email covering all of their bookings in the batch.
 * Body: { ids: string[], action: 'approve' | 'reject' | 'cancel' }
 */
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  if (!(await getAuthUser(env, request))) return error('Not authenticated', 401);
  const input = await parseBody(request, bulkBookingActionSchema);
  if (input instanceof Response) return input;
  const user = await requirePermission(env, request, input.action === 'cancel' ? 'bookings.manage' : 'bookings.approve');
  if (user instanceof Response) return user;

  const ids = [...new Set(input.ids)];
  const results: { id: string; ok: boolean; code?: string; message?: string }[] = [];
  const emails: BookingEmail[] = [];
  for (const id of ids) {
    const result = await transitionBooking(env, { bookingId: id, to: TARGET[input.action], actorId: user.id, actorIsAdmin: true, notify: false });
    if (result.ok) {
      results.push({ id, ok: true });
      if (result.email) emails.push(result.email);
    } else {
      results.push({ id, ok: false, code: result.code, message: transitionErrorMessage(result.code) });
    }
  }

  await sendBookingEmails(env, emails, newId('bulk'));
  return json({ results, updated: results.filter((r) => r.ok).length });
};
