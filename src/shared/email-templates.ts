/**
 * Email templates (FR06). The defaults live here in code; administrators can
 * override the subject and bodies, and enable or disable automated templates,
 * from Admin → Email templates (stored in the email_templates table).
 */

export type EmailTemplateKey =
  | 'booking_request_received'
  | 'booking_approved'
  | 'booking_rejected'
  | 'booking_confirmation'
  | 'booking_amended'
  | 'booking_amendment_rejected'
  | 'booking_cancelled'
  | 'provisional_booking'
  | 'provisional_expired'
  | 'payment_reminder'
  | 'organisation_invitation'
  | 'password_reset';

export interface TemplateDefinition {
  key: EmailTemplateKey;
  name: string;
  trigger: string;
  subject: string;
  body_text: string;
  /**
   * Required templates cannot be disabled (the feature stops working without
   * them), and their parameters are never stored for retries because they
   * contain single-use links.
   */
  required?: boolean;
  /** Parameters specific to this template, beyond the common ones. */
  extra_params?: string[];
}

/** Parameters available in every template. */
export const COMMON_PARAMS = ['customer_name', 'customer_email', 'venue_name', 'contact_email'] as const;

/** Parameters describing the booking, for booking templates. */
export const BOOKING_PARAMS = [
  'organisation_name',
  'booking_reference',
  'resource_name',
  'booking_date',
  'booking_start_time',
  'booking_end_time',
  'booking_cost',
  'booking_status',
] as const;

export const PARAM_DESCRIPTION: Record<string, string> = {
  customer_name: "The customer's full name",
  customer_email: "The customer's email address",
  venue_name: 'Venue name from Settings',
  contact_email: 'Contact email from Settings',
  organisation_name: 'Organisation the booking is for (blank for personal bookings)',
  booking_reference: 'Booking (or series) reference',
  resource_name: 'Booked resource',
  booking_date: 'Booking date, or the range of dates for a recurring booking',
  booking_start_time: 'Start time (UK)',
  booking_end_time: 'End time (UK)',
  booking_cost: 'Agreed total, e.g. £20.00',
  booking_status: 'Booking status',
  expiry_date: 'When a provisional hold expires',
  decision_note: "The administrator's message",
  payment_instructions: 'Payment instructions from Settings',
  inviter_name: 'Who sent the invitation',
  invitation_role: 'Role offered (manager or member)',
  invitation_url: 'Link to accept or decline',
  invitation_expiry: 'When the invitation expires',
  reset_url: 'Password reset link',
};

const SIGN_OFF = '\n\nThank you,\n{{ venue_name }}\nQuestions? Contact {{ contact_email }}';

export const TEMPLATE_DEFINITIONS: TemplateDefinition[] = [
  {
    key: 'booking_request_received',
    name: 'Booking request received',
    trigger: 'A booking is submitted for a resource that needs approval',
    subject: 'We have received your booking request {{ booking_reference }}',
    body_text: 'Hi {{ customer_name }},\n\nWe have received your request for {{ resource_name }} on {{ booking_date }} ({{ booking_start_time }}–{{ booking_end_time }}). It is awaiting approval.\nReference: {{ booking_reference }}' + SIGN_OFF,
  },
  {
    key: 'booking_approved',
    name: 'Booking approved',
    trigger: 'An administrator approves a booking request',
    subject: 'Your booking {{ booking_reference }} has been approved',
    body_text: 'Hi {{ customer_name }},\n\nGood news: your booking for {{ resource_name }} on {{ booking_date }} is approved and confirmed.\nTotal: {{ booking_cost }}\nReference: {{ booking_reference }}' + SIGN_OFF,
  },
  {
    key: 'booking_rejected',
    name: 'Booking rejected',
    trigger: 'An administrator rejects a booking request',
    subject: 'Your booking {{ booking_reference }} could not be approved',
    body_text: 'Hi {{ customer_name }},\n\nUnfortunately your booking request for {{ resource_name }} on {{ booking_date }} could not be approved.\nReference: {{ booking_reference }}' + SIGN_OFF,
  },
  {
    key: 'booking_confirmation',
    name: 'Booking confirmation',
    trigger: 'A booking is confirmed without needing approval, or a provisional hold is confirmed',
    subject: 'Your {{ venue_name }} booking {{ booking_reference }} is confirmed',
    body_text: 'Hi {{ customer_name }},\n\nYour booking for {{ resource_name }} on {{ booking_date }} ({{ booking_start_time }}–{{ booking_end_time }}) is confirmed.\nTotal: {{ booking_cost }}\nReference: {{ booking_reference }}' + SIGN_OFF,
  },
  {
    key: 'booking_amended',
    name: 'Booking amendment',
    trigger: 'A change to a booking is approved or made by an administrator',
    subject: 'Your booking {{ booking_reference }} has been changed',
    body_text: 'Hi {{ customer_name }},\n\nYour booking has been changed. It is now for {{ resource_name }} on {{ booking_date }} ({{ booking_start_time }}–{{ booking_end_time }}).\nTotal: {{ booking_cost }}\nReference: {{ booking_reference }}' + SIGN_OFF,
  },
  {
    key: 'booking_amendment_rejected',
    name: 'Booking change not approved',
    trigger: 'An administrator rejects a change request',
    subject: 'Your change request for booking {{ booking_reference }} was not approved',
    body_text: 'Hi {{ customer_name }},\n\nWe could not approve your requested change to booking {{ booking_reference }}. Your original booking for {{ resource_name }} on {{ booking_date }} ({{ booking_start_time }}–{{ booking_end_time }}) is unchanged.\n{{ decision_note }}' + SIGN_OFF,
    extra_params: ['decision_note'],
  },
  {
    key: 'booking_cancelled',
    name: 'Booking cancellation',
    trigger: 'A booking (or dates in a series) is cancelled',
    subject: 'Your booking {{ booking_reference }} has been cancelled',
    body_text: 'Hi {{ customer_name }},\n\nYour booking for {{ resource_name }} on {{ booking_date }} has been cancelled.\nReference: {{ booking_reference }}' + SIGN_OFF,
  },
  {
    key: 'provisional_booking',
    name: 'Provisional booking',
    trigger: 'A provisional hold is placed',
    subject: 'Your provisional booking {{ booking_reference }} is held until {{ expiry_date }}',
    body_text: 'Hi {{ customer_name }},\n\nWe are holding {{ resource_name }} for you on {{ booking_date }} ({{ booking_start_time }}–{{ booking_end_time }}) as a provisional booking.\nThe hold lasts until {{ expiry_date }}. If it has not been confirmed by then it will expire and the time will be released.\nTotal if confirmed: {{ booking_cost }}\nReference: {{ booking_reference }}' + SIGN_OFF,
    extra_params: ['expiry_date'],
  },
  {
    key: 'provisional_expired',
    name: 'Provisional expiry',
    trigger: 'A provisional hold expires without being confirmed',
    subject: 'Your provisional booking {{ booking_reference }} has expired',
    body_text: 'Hi {{ customer_name }},\n\nYour provisional booking for {{ resource_name }} on {{ booking_date }} was not confirmed in time, so it has expired and the time has been released.\nReference: {{ booking_reference }}\n\nYou are welcome to make a new booking if the time is still free.' + SIGN_OFF,
  },
  {
    key: 'payment_reminder',
    name: 'Payment reminder',
    trigger: 'An administrator sends a reminder from the booking page',
    subject: 'Payment reminder for booking {{ booking_reference }}',
    body_text: 'Hi {{ customer_name }},\n\nThis is a reminder that {{ booking_cost }} is due for your booking of {{ resource_name }} on {{ booking_date }}.\n{{ payment_instructions }}\nPlease quote reference {{ booking_reference }}.' + SIGN_OFF,
    extra_params: ['payment_instructions'],
  },
  {
    key: 'organisation_invitation',
    name: 'Organisation invitation',
    trigger: 'An Organisation Manager invites someone',
    subject: '{{ inviter_name }} has invited you to join {{ organisation_name }}',
    body_text: 'Hello,\n\n{{ inviter_name }} has invited you to join {{ organisation_name }} on the {{ venue_name }} booking site as an {{ invitation_role }}.\n\nAccept or decline the invitation here:\n{{ invitation_url }}\n\nThis invitation expires on {{ invitation_expiry }}. If you were not expecting it, you can ignore this email.',
    required: true,
    extra_params: ['organisation_name', 'inviter_name', 'invitation_role', 'invitation_url', 'invitation_expiry'],
  },
  {
    key: 'password_reset',
    name: 'Password reset',
    trigger: 'A user asks to reset their password',
    subject: 'Reset your {{ venue_name }} password',
    body_text: 'Hi {{ customer_name }},\n\nUse the link below to reset your password. It expires in 1 hour.\n{{ reset_url }}\n\nIf you did not request this, you can ignore this email.',
    required: true,
    extra_params: ['reset_url'],
  },
];

const BOOKING_TEMPLATES = new Set<EmailTemplateKey>([
  'booking_request_received', 'booking_approved', 'booking_rejected', 'booking_confirmation', 'booking_amended',
  'booking_amendment_rejected', 'booking_cancelled', 'provisional_booking', 'provisional_expired', 'payment_reminder',
]);

export function templateDefinition(key: string): TemplateDefinition | undefined {
  return TEMPLATE_DEFINITIONS.find((t) => t.key === key);
}

/** Every parameter a template may use. */
export function templateParams(key: EmailTemplateKey): string[] {
  const def = templateDefinition(key);
  return [...COMMON_PARAMS, ...(BOOKING_TEMPLATES.has(key) ? BOOKING_PARAMS : []), ...(def?.extra_params ?? [])].filter(
    (p, i, all) => all.indexOf(p) === i,
  );
}

const PLACEHOLDER = /{{\s*([a-z_]+)\s*}}/g;

/** Placeholders in the text that the template does not support. */
export function unknownParams(key: EmailTemplateKey, ...texts: (string | null | undefined)[]): string[] {
  const allowed = new Set(templateParams(key));
  const found = new Set<string>();
  for (const t of texts) for (const m of (t ?? '').matchAll(PLACEHOLDER)) if (!allowed.has(m[1])) found.add(m[1]);
  return [...found];
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Fill a template. Parameter values are user-provided data (names, notes), so
 * they are HTML-escaped in the HTML output and stripped of line breaks in the
 * subject. With no HTML body, the HTML is the escaped text with line breaks.
 */
export function renderEmail(content: { subject: string; body_text: string; body_html?: string | null }, params: Record<string, string>): RenderedEmail {
  const value = (key: string) => params[key] ?? '';
  const subject = content.subject.replace(PLACEHOLDER, (_, k: string) => value(k).replace(/[\r\n]+/g, ' ')).trim();
  const text = content.body_text.replace(PLACEHOLDER, (_, k: string) => value(k));
  const inner = content.body_html
    ? content.body_html.replace(PLACEHOLDER, (_, k: string) => escapeHtml(value(k)))
    : escapeHtml(text)
        .split(/\n{2,}/)
        .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
        .join('\n');
  const html = `<!doctype html><html><body style="font-family:'Nunito Sans',Arial,sans-serif;color:#1b1b1b;line-height:1.5">${inner}</body></html>`;
  return { subject, text, html };
}

/** Example values for previews and test emails. */
export const SAMPLE_PARAMS: Record<string, string> = {
  customer_name: 'Alex Example',
  customer_email: 'alex@example.com',
  organisation_name: '1st Stratton Scout Group',
  booking_reference: 'SS-ABC123',
  resource_name: 'Main Hall',
  booking_date: 'Tue, 6 Jan 2026',
  booking_start_time: '19:00',
  booking_end_time: '21:00',
  booking_cost: '£20.00',
  booking_status: 'confirmed',
  expiry_date: '8 Jan 2026, 19:00',
  decision_note: 'The hall is being decorated that week.',
  inviter_name: 'Sam Leader',
  invitation_role: 'member',
  invitation_url: 'https://example.com/invitations/sample',
  invitation_expiry: '13 Jan 2026',
  reset_url: 'https://example.com/reset-password?token=sample',
};
