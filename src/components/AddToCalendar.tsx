import { Link } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { bookingCalendarEvent, googleCalendarUrl, outlookCalendarUrl } from '@shared/ical';

interface BookingForCalendar {
  id: string;
  reference: string;
  resource_name: string;
  starts_at: string;
  ends_at: string;
  status: string;
  created_at: string;
  organisation_name: string | null;
}

/**
 * "Add to calendar" for one booking (FR17 §2.2): an .ics download that works
 * with Apple Calendar, Outlook and most other apps, plus direct Google and
 * Outlook links. These are one-off copies; a subscription keeps up to date.
 */
export function AddToCalendar({ booking }: { booking: BookingForCalendar }) {
  const { data: site } = useApi<{ venue_name: string; venue_address?: string }>('/site');
  if (!['confirmed', 'provisional', 'pending_approval'].includes(booking.status)) return null;
  const event = bookingCalendarEvent(
    { ...booking, updated_at: booking.created_at },
    { name: site?.venue_name ?? 'Stratton Scouts', address: site?.venue_address ?? '', baseUrl: window.location.origin, host: window.location.host },
    booking.organisation_name,
  );
  const link = 'btn-secondary text-center';
  return (
    <section className="card mt-4" aria-labelledby="add-to-calendar-heading">
      <h2 id="add-to-calendar-heading" className="text-lg">Add to your calendar</h2>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <a className={link} href={`/api/bookings/${booking.id}/calendar`} download={`${booking.reference}.ics`}>
          Download calendar file (.ics)
        </a>
        <a className={link} href={googleCalendarUrl(event)} target="_blank" rel="noopener noreferrer">Google Calendar</a>
        <a className={link} href={outlookCalendarUrl(event, 'office')} target="_blank" rel="noopener noreferrer">Outlook (work or school)</a>
        <a className={link} href={outlookCalendarUrl(event, 'live')} target="_blank" rel="noopener noreferrer">Outlook.com</a>
      </div>
      <p className="mt-3 text-sm text-gray-600">
        The calendar file works with Apple Calendar, Outlook and most other calendar apps. It is a copy, so it won’t change if the booking
        does. To keep your calendar up to date, <Link className="font-bold text-scout-purple underline" to="/account#calendar">subscribe to your bookings</Link>.
      </p>
    </section>
  );
}
