import type { Env } from './http';
import { newId, now } from './http';

export type EmailTemplate =
  | 'booking_confirmation'
  | 'booking_request_received'
  | 'booking_approved'
  | 'booking_rejected'
  | 'booking_cancelled'
  | 'password_reset';

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

/**
 * Send a transactional email. Idempotent via dedupeKey — duplicate sends
 * (e.g. retried booking submissions) are suppressed. Failures are recorded
 * but never thrown so that booking creation is not rolled back when the email
 * provider is temporarily unavailable.
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
  // Deduplicate if a key was supplied and already recorded.
  if (args.dedupeKey) {
    const existing = await env.DB.prepare(
      'SELECT id FROM email_events WHERE dedupe_key = ?',
    )
      .bind(args.dedupeKey)
      .first<{ id: string }>();
    if (existing) return;
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
      // console provider (development): log instead of sending.
      console.log(`[email:${args.template}] to=${args.to} subject="${subject}"`);
    }
  } catch (e) {
    status = 'failed';
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  try {
    await env.DB.prepare(
      'INSERT INTO email_events (id, booking_id, recipient, template, dedupe_key, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        newId('eml'),
        args.bookingId ?? null,
        args.to,
        args.template,
        args.dedupeKey ?? null,
        status,
        errorMsg,
        now(),
      )
      .run();
  } catch {
    // Never let email bookkeeping break the caller.
  }
}
