import type { Env } from './http';
import { newId, now } from './http';

export type EmailTemplate =
  | 'booking_confirmation'
  | 'booking_request_received'
  | 'booking_approved'
  | 'booking_rejected'
  | 'booking_cancelled'
  | 'password_reset'
  | 'organisation_invitation';

interface TemplateDef {
  subject: string;
  body: string; // may contain {{ placeholders }}
}

// Templates stored as application configuration (Release 1). A fully
// configurable editor is planned for a later release.
const TEMPLATES: Record<EmailTemplate, TemplateDef> = {
  booking_confirmation: {
    subject: 'Your Stratton Scouts booking {{ booking_reference }} is confirmed',
    body: 'Hi {{ customer_name }},\n\nYour booking for {{ resource_name }} on {{ booking_date }} ({{ booking_start_time }}–{{ booking_end_time }}) is confirmed.\nTotal: {{ booking_cost }}\nReference: {{ booking_reference }}\n\nThank you,\nStratton Scouts',
  },
  booking_request_received: {
    subject: 'We have received your booking request {{ booking_reference }}',
    body: 'Hi {{ customer_name }},\n\nWe have received your request for {{ resource_name }} on {{ booking_date }} ({{ booking_start_time }}–{{ booking_end_time }}). It is awaiting approval.\nReference: {{ booking_reference }}\n\nThank you,\nStratton Scouts',
  },
  booking_approved: {
    subject: 'Your booking {{ booking_reference }} has been approved',
    body: 'Hi {{ customer_name }},\n\nGood news — your booking for {{ resource_name }} on {{ booking_date }} is approved and confirmed.\nTotal: {{ booking_cost }}\nReference: {{ booking_reference }}\n\nThank you,\nStratton Scouts',
  },
  booking_rejected: {
    subject: 'Your booking {{ booking_reference }} could not be approved',
    body: 'Hi {{ customer_name }},\n\nUnfortunately your booking request for {{ resource_name }} on {{ booking_date }} could not be approved.\nReference: {{ booking_reference }}\n\nThank you,\nStratton Scouts',
  },
  booking_cancelled: {
    subject: 'Your booking {{ booking_reference }} has been cancelled',
    body: 'Hi {{ customer_name }},\n\nYour booking for {{ resource_name }} on {{ booking_date }} has been cancelled.\nReference: {{ booking_reference }}\n\nThank you,\nStratton Scouts',
  },
  organisation_invitation: {
    subject: '{{ inviter_name }} has invited you to join {{ organisation_name }}',
    body: 'Hello,\n\n{{ inviter_name }} has invited you to join {{ organisation_name }} on the {{ venue_name }} booking site as an {{ invitation_role }}.\n\nAccept or decline the invitation here:\n{{ invitation_url }}\n\nThis invitation expires on {{ invitation_expiry }}. If you were not expecting it, you can ignore this email.',
  },
  password_reset: {
    subject: 'Reset your Stratton Scouts password',
    body: 'Hi {{ customer_name }},\n\nUse the link below to reset your password. It expires in 1 hour.\n{{ reset_url }}\n\nIf you did not request this, you can ignore this email.',
  },
};

export function renderTemplate(template: EmailTemplate, params: Record<string, string>): TemplateDef {
  const def = TEMPLATES[template];
  const fill = (s: string) =>
    s.replace(/{{\s*([a-z_]+)\s*}}/g, (_, key: string) => params[key] ?? '');
  return { subject: fill(def.subject), body: fill(def.body) };
}

const LONDON = 'Europe/London';
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON, hour: '2-digit', minute: '2-digit' });

/** Booking date/time placeholders, formatted in UK local time (GMT/BST). */
export function bookingTimeParams(startsAt: string, endsAt: string): {
  booking_date: string;
  booking_start_time: string;
  booking_end_time: string;
} {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const startDate = dateFmt.format(start);
  const endDate = dateFmt.format(end);
  return {
    booking_date: startDate === endDate ? startDate : `${startDate} to ${endDate}`,
    booking_start_time: timeFmt.format(start),
    booking_end_time: timeFmt.format(end),
  };
}

/**
 * Send a transactional email. Idempotent via dedupeKey: a key that has already
 * been sent (or is being sent) is skipped, so retried requests never send a
 * duplicate, while a key whose previous attempt failed may be sent again.
 * Failures are recorded but never thrown so that booking creation is not
 * rolled back when the email provider is temporarily unavailable.
 */
export async function sendEmail(
  env: Env,
  args: {
    to: string;
    template: EmailTemplate;
    params: Record<string, string>;
    bookingId?: string;
    dedupeKey?: string;
  },
): Promise<void> {
  const eventId = newId('eml');

  // Claim the dedupe key before sending. The upsert only takes over an
  // existing row when its previous attempt failed.
  if (args.dedupeKey) {
    try {
      const claim = await env.DB.prepare(
        `INSERT INTO email_events (id, booking_id, recipient, template, dedupe_key, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, 'sending', NULL, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET status = 'sending', error = NULL, created_at = excluded.created_at
         WHERE email_events.status = 'failed'`,
      )
        .bind(eventId, args.bookingId ?? null, args.to, args.template, args.dedupeKey, now())
        .run();
      if (claim.meta.changes === 0) return;
    } catch {
      // If bookkeeping is unavailable, still attempt the send.
    }
  }

  const { subject, body } = renderTemplate(args.template, args.params);
  let status = 'sent';
  let errorMsg: string | null = null;

  try {
    const provider = (env.EMAIL_PROVIDER ?? 'console').toLowerCase();
    if (provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.EMAIL_API_KEY ?? ''}`,
          'content-type': 'application/json',
          // Lets the provider drop a duplicate if two sends race.
          ...(args.dedupeKey ? { 'Idempotency-Key': args.dedupeKey } : {}),
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM ?? 'bookings@strattonscouts.example',
          to: args.to,
          subject,
          text: body,
        }),
      });
      if (!res.ok) {
        status = 'failed';
        errorMsg = `provider responded ${res.status}`;
      }
    } else {
      // console provider (development): log instead of sending. The body is
      // included outside production so reset links can be used locally.
      console.log(`[email:${args.template}] to=${args.to} subject="${subject}"`);
      if (env.ENVIRONMENT !== 'production') console.log(body);
    }
  } catch (e) {
    status = 'failed';
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  try {
    if (args.dedupeKey) {
      await env.DB.prepare('UPDATE email_events SET status = ?, error = ? WHERE dedupe_key = ?')
        .bind(status, errorMsg, args.dedupeKey)
        .run();
    } else {
      await env.DB.prepare(
        'INSERT INTO email_events (id, booking_id, recipient, template, dedupe_key, status, error, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
      )
        .bind(eventId, args.bookingId ?? null, args.to, args.template, status, errorMsg, now())
        .run();
    }
  } catch {
    // Never let email bookkeeping break the caller.
  }
}
