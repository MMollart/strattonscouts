import type { Env } from './http';
import { sendEmail, type EmailTemplate } from './email';

/** One customer email about one booking's change of status, not yet sent. */
export interface BookingEmail {
  to: string;
  bookingId: string;
  /** When the booking starts (ISO), to list several in date order. */
  startsAt: string;
  template: EmailTemplate;
  /** The template's values: customer_name and the booking's own details. */
  params: Record<string, string>;
}

// How each one-booking email's outcome reads in the combined email's list.
const STATUS_LABEL: Partial<Record<EmailTemplate, string>> = {
  booking_approved: 'Approved',
  booking_confirmation: 'Confirmed',
  booking_rejected: 'Not approved',
  booking_cancelled: 'Cancelled',
  provisional_expired: 'Expired',
};

// Values that describe one booking rather than the person, shown per card.
const PER_BOOKING = ['booking_reference', 'resource_name', 'booking_date', 'booking_start_time', 'booking_end_time', 'booking_cost', 'booking_status', 'organisation_name'];

/**
 * Send booking emails so nobody gets more than one from a single action
 * (FR06): someone with one booking in the batch gets that booking's usual
 * email; someone with several gets one "Several bookings updated" email
 * listing each booking and its new status. `batchKey` identifies the action
 * so a retried request does not send the combined email twice.
 */
export async function sendBookingEmails(env: Env, emails: BookingEmail[], batchKey?: string): Promise<void> {
  const byRecipient = new Map<string, BookingEmail[]>();
  for (const e of emails) {
    const key = e.to.toLowerCase();
    byRecipient.set(key, [...(byRecipient.get(key) ?? []), e]);
  }

  for (const [recipient, theirs] of byRecipient) {
    if (theirs.length === 1) {
      const [e] = theirs;
      await sendEmail(env, { to: e.to, bookingId: e.bookingId, dedupeKey: `${e.bookingId}:${e.template}`, template: e.template, params: e.params });
      continue;
    }
    const sorted = [...theirs].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    await sendEmail(env, {
      to: theirs[0].to,
      bookingId: sorted[0].bookingId,
      dedupeKey: `${batchKey ?? sorted.map((e) => e.bookingId).join(',')}:${recipient}:bookings_updated`,
      template: 'bookings_updated',
      params: {
        customer_name: theirs[0].params.customer_name ?? '',
        booking_count: String(theirs.length),
        booking_reference: sorted.map((e) => e.params.booking_reference).join(', '),
      },
      items: sorted.map((e) => ({
        ...Object.fromEntries(PER_BOOKING.map((k) => [k, e.params[k] ?? ''])),
        booking_status: STATUS_LABEL[e.template] ?? e.params.booking_status ?? '',
      })),
    });
  }
}
