import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { getAuthUser } from '../../_lib/auth';
import { parseBody } from '../../_lib/request';
import { createSeries, seriesDateText } from '../../_lib/recurring';
import { resolveSeriesRequest } from '../../_lib/series-request';
import { bookingTimeParams, sendEmail } from '../../_lib/email';
import { seriesCreateSchema } from '@shared/validation';
import { formatGBP } from '@shared/pricing';
import { formatLondon } from '@shared/londonTime';

// Create a recurring booking (FR05). All-or-nothing: unavailable dates must be
// listed in exclude_dates, which the customer chooses explicitly on review.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const input = await parseBody(request, seriesCreateSchema);
  if (input instanceof Response) return input;
  const req = await resolveSeriesRequest(env, user, input);
  if (req instanceof Response) return req;

  const result = await createSeries(env, req, input.exclude_dates);
  if (!result.ok) {
    const status = result.code === 'unavailable' || result.code === 'conflict' ? 409 : result.code === 'resource_not_found' ? 404 : 400;
    return error(result.message, status, { code: result.code, ...('occurrences' in result ? { occurrences: result.occurrences } : {}) });
  }

  // One email for the whole series, not one per date.
  const customer = await env.DB.prepare('SELECT email, full_name FROM users WHERE id = ?').bind(req.userId).first<{ email: string; full_name: string }>();
  if (customer) {
    const first = result.bookings[0];
    const last = result.bookings[result.bookings.length - 1];
    const template = result.status === 'confirmed' ? 'booking_confirmation' : 'booking_request_received';
    const day = { dateStyle: 'medium' } as const;
    await sendEmail(env, {
      to: customer.email,
      dedupeKey: `${result.seriesId}:${template}`,
      template,
      params: {
        customer_name: customer.full_name,
        booking_reference: result.reference,
        resource_name: result.resourceName,
        ...bookingTimeParams(first.startsAt, first.endsAt),
        booking_date: seriesDateText(result.bookings.length, formatLondon(first.startsAt, day), formatLondon(last.startsAt, day)),
        booking_cost: formatGBP(result.totalPence),
        booking_status: result.status,
      },
    });
  }

  return json(
    { id: result.seriesId, reference: result.reference, status: result.status, booking_ids: result.bookings.map((b) => b.id), total_pence: result.totalPence },
    201,
  );
};
