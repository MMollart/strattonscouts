// Release 3 / FR17: iCalendar (RFC 5545) output and "add to calendar" links.
// Times are written in the venue's time zone (Europe/London) with a
// VTIMEZONE block, so calendars show the right local time on both sides of
// the clocks changing.

import { VENUE_TIME_ZONE, toLondon } from './londonTime';

export type CalendarEventStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';

export interface CalendarEvent {
  /** Stable across changes, so an amended booking updates the same entry. */
  uid: string;
  /** Increases whenever the event changes. */
  sequence: number;
  /** When the event was last changed (UTC ISO). */
  updatedAt: string;
  startsAt: string;
  endsAt: string;
  summary: string;
  description: string;
  location: string;
  status: CalendarEventStatus;
  url?: string;
}

// Europe/London since 1996: BST from the last Sunday in March at 01:00 UTC
// to the last Sunday in October at 01:00 UTC.
const VTIMEZONE_LONDON = [
  'BEGIN:VTIMEZONE',
  `TZID:${VENUE_TIME_ZONE}`,
  'X-LIC-LOCATION:Europe/London',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0000',
  'TZOFFSETTO:+0100',
  'TZNAME:BST',
  'DTSTART:19700329T010000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0000',
  'TZNAME:GMT',
  'DTSTART:19701025T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/** Escape a TEXT value (RFC 5545 §3.3.11). */
export function icsEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

const encoder = new TextEncoder();

/** Fold a content line at 75 octets, never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    // continuation lines start with a space, which counts towards their 75
    const limit = out.length ? 74 : 75;
    if (size + n > limit) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

/** UK local date-time for DTSTART;TZID=Europe/London (YYYYMMDDTHHMMSS). */
export function icsLocal(iso: string): string {
  const { date, time } = toLondon(iso);
  const seconds = String(new Date(iso).getUTCSeconds()).padStart(2, '0');
  return `${date.replace(/-/g, '')}T${time.replace(':', '')}${seconds}`;
}

/** UTC date-time (YYYYMMDDTHHMMSSZ). */
export function icsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function eventLines(e: CalendarEvent, stamp: string): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${icsUtc(stamp)}`,
    `LAST-MODIFIED:${icsUtc(e.updatedAt)}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTART;TZID=${VENUE_TIME_ZONE}:${icsLocal(e.startsAt)}`,
    `DTEND;TZID=${VENUE_TIME_ZONE}:${icsLocal(e.endsAt)}`,
    `SUMMARY:${icsEscape(e.summary)}`,
    `DESCRIPTION:${icsEscape(e.description)}`,
    ...(e.location ? [`LOCATION:${icsEscape(e.location)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []),
    `STATUS:${e.status}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
  ];
}

/**
 * A complete iCalendar document. `refreshHours` hints how often a subscribed
 * calendar should check for changes; calendar apps decide for themselves.
 */
export function buildCalendar(opts: { name: string; events: CalendarEvent[]; refreshHours?: number; now?: string }): string {
  const stamp = opts.now ?? new Date().toISOString();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Stratton Scouts//Resource Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(opts.name)}`,
    `X-WR-TIMEZONE:${VENUE_TIME_ZONE}`,
    ...(opts.refreshHours
      ? [`REFRESH-INTERVAL;VALUE=DURATION:PT${opts.refreshHours}H`, `X-PUBLISHED-TTL:PT${opts.refreshHours}H`]
      : []),
    ...VTIMEZONE_LONDON,
    ...opts.events.flatMap((e) => eventLines(e, stamp)),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** "Add to Google Calendar" link. Times in UTC; Google shows them in the viewer's zone. */
export function googleCalendarUrl(e: Pick<CalendarEvent, 'summary' | 'description' | 'location' | 'startsAt' | 'endsAt'>): string {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.summary,
    dates: `${icsUtc(e.startsAt)}/${icsUtc(e.endsAt)}`,
    details: e.description,
    location: e.location,
    ctz: VENUE_TIME_ZONE,
  });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

/** "Add to Outlook" link: work or school accounts (Office 365), or Outlook.com. */
export function outlookCalendarUrl(
  e: Pick<CalendarEvent, 'summary' | 'description' | 'location' | 'startsAt' | 'endsAt'>,
  account: 'office' | 'live' = 'office',
): string {
  const p = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: e.summary,
    startdt: new Date(e.startsAt).toISOString(),
    enddt: new Date(e.endsAt).toISOString(),
    body: e.description,
    location: e.location,
  });
  const host = account === 'office' ? 'outlook.office.com' : 'outlook.live.com';
  return `https://${host}/calendar/0/deeplink/compose?${p.toString()}`;
}

/** Calendar wording for a booking status. Feeds leave out bookings that no longer hold the resource. */
export function calendarStatus(status: string): { status: CalendarEventStatus; label: string } {
  switch (status) {
    case 'confirmed':
      return { status: 'CONFIRMED', label: 'Confirmed' };
    case 'provisional':
      return { status: 'TENTATIVE', label: 'Provisional' };
    case 'pending_approval':
      return { status: 'TENTATIVE', label: 'Awaiting approval' };
    case 'rejected':
      return { status: 'CANCELLED', label: 'Rejected' };
    case 'expired':
      return { status: 'CANCELLED', label: 'Expired' };
    default:
      return { status: 'CANCELLED', label: 'Cancelled' };
  }
}

export interface BookingCalendarInput {
  id: string;
  reference: string;
  resource_name: string;
  starts_at: string;
  ends_at: string;
  status: string;
  updated_at: string;
}

/**
 * The calendar entry for a booking. `who` is only given where showing the
 * organisation or customer name is allowed (FR17 §2.6). Nothing private
 * (contact details, notes, prices, admin comments) is ever included.
 */
export function bookingCalendarEvent(
  b: BookingCalendarInput,
  venue: { name: string; address: string; baseUrl: string; host: string },
  who?: string | null,
): CalendarEvent {
  const s = calendarStatus(b.status);
  const tag = s.status === 'CONFIRMED' ? '' : ` (${s.label.toLowerCase()})`;
  const url = venue.baseUrl ? `${venue.baseUrl.replace(/\/$/, '')}/bookings/${b.id}` : undefined;
  const description = [
    `Booking reference: ${b.reference}`,
    `Status: ${s.label}`,
    `Resource: ${b.resource_name}`,
    `Venue: ${venue.name}`,
    ...(who ? [`Booked for: ${who}`] : []),
    ...(url ? [`View or manage this booking: ${url}`] : []),
  ].join('\n');
  return {
    uid: `${b.id}@${venue.host || 'strattonscouts'}`,
    // whole seconds since 2020: always increases when the booking is changed
    sequence: Math.max(0, Math.floor((Date.parse(b.updated_at) - Date.UTC(2020, 0, 1)) / 1000)),
    updatedAt: b.updated_at,
    startsAt: b.starts_at,
    endsAt: b.ends_at,
    summary: `${b.resource_name}${who ? `: ${who}` : ''}${tag}`,
    description,
    location: [b.resource_name, venue.name, venue.address].filter(Boolean).join(', '),
    status: s.status,
    url,
  };
}
