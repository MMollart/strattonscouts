import type { Env } from '../../../_lib/http';
import { error } from '../../../_lib/http';
import { getAuthUser } from '../../../_lib/auth';
import { bookingAccess } from '../../../_lib/booking-access';
import { effectiveStatusSql, resourceNamesSql } from '../../../_lib/availability-sql';
import { calendarResponse, venueInfo } from '../../../_lib/calendar';
import { bookingCalendarEvent, buildCalendar } from '@shared/ical';

/** Download one booking as an .ics file (FR17 §2.2), for anyone who can see the booking. */
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const b = await env.DB.prepare(
    `SELECT b.id, b.reference, b.user_id, b.organisation_id, b.starts_at, b.ends_at, ${effectiveStatusSql('b')} AS status, b.updated_at,
            ${resourceNamesSql('b')} AS resource_name, o.name AS organisation_name
     FROM bookings b JOIN resources r ON r.id = b.resource_id LEFT JOIN organisations o ON o.id = b.organisation_id
     WHERE b.id = ?`,
  )
    .bind(String(params.id))
    .first<{ id: string; reference: string; user_id: string; organisation_id: string | null; starts_at: string; ends_at: string; status: string; updated_at: string; resource_name: string; organisation_name: string | null }>();
  if (!b) return error('Booking not found', 404);
  if (!(await bookingAccess(env, user, b)).canView) return error('Not authorised', 403);

  const venue = await venueInfo(env, request);
  const body = buildCalendar({ name: `${venue.name} booking ${b.reference}`, events: [bookingCalendarEvent(b, venue, b.organisation_name)] });
  return calendarResponse(body, `${b.reference}.ics`, 'attachment');
};
