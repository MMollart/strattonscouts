/**
 * Email templates (FR06). The defaults live here in code; administrators can
 * override the subject and each section, and enable or disable automated
 * templates, from Admin → Email templates (stored in the email_templates
 * table). Every email is sent in the branded layout (email-layout.ts), built
 * from the five sections below: title, body, detail card, thanks and footer.
 */

import { emailLayout, type BadgeColour, type BodyBlock } from './email-layout';

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
  | 'password_reset'
  | 'maintenance_notice'
  | 'bookings_updated';

/** The editable parts of an email. Sections are plain text with {{ placeholders }}. */
export interface EmailContent {
  subject: string;
  /** The headline. */
  title: string;
  /**
   * Paragraphs separated by blank lines. A paragraph that is just
   * [Button text](link) becomes a button.
   */
  body: string;
  /** One "Label: value" per line; blank hides the card. */
  detail_card: string;
  /** The sign-off; its last line is bold. */
  thanks: string;
  /** Lines in the teal footer; lines starting with # are bold. */
  footer: string;
}

export const SECTION_KEYS = ['title', 'body', 'detail_card', 'thanks', 'footer'] as const;

/** Every editable text of an email, for checking its placeholders. */
export function contentTexts(c: EmailContent): string[] {
  return [c.subject, ...SECTION_KEYS.map((k) => c[k])];
}

export interface TemplateDefinition extends EmailContent {
  key: EmailTemplateKey;
  name: string;
  trigger: string;
  /** Status pill above the title. */
  badge?: { label: string; colour: BadgeColour };
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
  maintenance_title: 'What the maintenance is',
  maintenance_period: 'When the maintenance takes place (UK time)',
  maintenance_message: "The administrator's message about the maintenance",
  booking_count: 'How many bookings the email lists',
};

const THANKS = 'Thank you,\n{{ venue_name }}';
const FOOTER = 'Questions? Get in touch on {{ contact_email }}\n#PlaceToBelong';
const HI = 'Hi {{ customer_name }},';
const WHEN = 'Date: {{ booking_date }}\nTime: {{ booking_start_time }}–{{ booking_end_time }}';
const REF = 'Reference: {{ booking_reference }}';
const lines = (...l: string[]) => l.join('\n');
const paras = (...p: string[]) => p.join('\n\n');

export const TEMPLATE_DEFINITIONS: TemplateDefinition[] = [
  {
    key: 'booking_request_received',
    name: 'Booking request received',
    trigger: 'A booking is submitted for a resource that needs approval',
    subject: 'We have received your booking request {{ booking_reference }}',
    badge: { label: 'Awaiting approval', colour: 'navy' },
    title: 'We’ve got your request.',
    body: paras(HI, 'Thanks for getting in touch. We’ve received your request and it’s now waiting for approval. We’ll be in touch as soon as it’s been looked at.'),
    detail_card: lines('What you asked for: {{ resource_name }}', WHEN, REF),
    thanks: THANKS,
    footer: FOOTER,
  },
  {
    key: 'booking_approved',
    name: 'Booking approved',
    trigger: 'An administrator approves a booking request',
    subject: 'Your booking {{ booking_reference }} has been approved',
    badge: { label: 'Approved', colour: 'green' },
    title: 'You’re booked in!',
    body: paras(HI, 'Good news: your booking has been approved and is confirmed.'),
    detail_card: lines('Booking: {{ resource_name }}', WHEN, 'Total: {{ booking_cost }}', REF),
    thanks: THANKS,
    footer: FOOTER,
  },
  {
    key: 'booking_rejected',
    name: 'Booking rejected',
    trigger: 'An administrator rejects a booking request',
    subject: 'Your booking {{ booking_reference }} could not be approved',
    badge: { label: 'Not approved', colour: 'red' },
    title: 'Sorry, we can’t fit you in.',
    body: paras(HI, 'Unfortunately your booking request could not be approved.'),
    detail_card: lines('What you asked for: {{ resource_name }}', WHEN, REF),
    thanks: THANKS,
    footer: FOOTER,
  },
  {
    key: 'booking_confirmation',
    name: 'Booking confirmation',
    trigger: 'A booking is confirmed without needing approval, or a provisional hold is confirmed',
    subject: 'Your {{ venue_name }} booking {{ booking_reference }} is confirmed',
    badge: { label: 'Confirmed', colour: 'green' },
    title: 'Your booking is confirmed.',
    body: paras(HI, 'You’re all set. Here are the details of your booking.'),
    detail_card: lines('Booking: {{ resource_name }}', WHEN, 'Total: {{ booking_cost }}', REF),
    thanks: THANKS,
    footer: FOOTER,
  },
  {
    key: 'booking_amended',
    name: 'Booking amendment',
    trigger: 'A change to a booking is approved or made by an administrator',
    subject: 'Your booking {{ booking_reference }} has been changed',
    badge: { label: 'Changed', colour: 'blue' },
    title: 'Your booking has changed.',
    body: paras(HI, 'Your booking has been updated. Here are the new details.'),
    detail_card: lines('Booking: {{ resource_name }}', WHEN, 'Total: {{ booking_cost }}', REF),
    thanks: THANKS,
    footer: FOOTER,
  },
  {
    key: 'booking_amendment_rejected',
    name: 'Booking change not approved',
    trigger: 'An administrator rejects a change request',
    subject: 'Your change request for booking {{ booking_reference }} was not approved',
    badge: { label: 'Change not approved', colour: 'orange' },
    title: 'Your booking is unchanged.',
    body: paras(HI, 'We couldn’t approve your requested change to booking {{ booking_reference }}. Your original booking still stands.', '{{ decision_note }}'),
    detail_card: lines('Booking: {{ resource_name }}', WHEN, REF),
    thanks: THANKS,
    footer: FOOTER,
    extra_params: ['decision_note'],
  },
  {
    key: 'booking_cancelled',
    name: 'Booking cancellation',
    trigger: 'A booking (or dates in a series) is cancelled',
    subject: 'Your booking {{ booking_reference }} has been cancelled',
    badge: { label: 'Cancelled', colour: 'red' },
    title: 'Your booking has been cancelled.',
    body: paras(HI, 'This booking has now been cancelled.'),
    detail_card: lines('Booking: {{ resource_name }}', 'Date: {{ booking_date }}', REF),
    thanks: THANKS,
    footer: FOOTER,
  },
  {
    key: 'provisional_booking',
    name: 'Provisional booking',
    trigger: 'A provisional hold is placed',
    subject: 'Your provisional booking {{ booking_reference }} is held until {{ expiry_date }}',
    badge: { label: 'Provisional', colour: 'yellow' },
    title: 'We’re holding it for you.',
    body: paras(HI, 'We’re holding this time for you as a provisional booking until {{ expiry_date }}. If it hasn’t been confirmed by then, it will expire and the time will be released.'),
    detail_card: lines('Booking: {{ resource_name }}', WHEN, 'Held until: {{ expiry_date }}', 'Total if confirmed: {{ booking_cost }}', REF),
    thanks: THANKS,
    footer: FOOTER,
    extra_params: ['expiry_date'],
  },
  {
    key: 'provisional_expired',
    name: 'Provisional expiry',
    trigger: 'A provisional hold expires without being confirmed',
    subject: 'Your provisional booking {{ booking_reference }} has expired',
    badge: { label: 'Expired', colour: 'navy' },
    title: 'Your hold has expired.',
    body: paras(HI, 'Your provisional booking wasn’t confirmed in time, so it has expired and the time has been released.', 'You’re welcome to make a new booking if the time is still free.'),
    detail_card: lines('Booking: {{ resource_name }}', 'Date: {{ booking_date }}', REF),
    thanks: THANKS,
    footer: FOOTER,
  },
  {
    key: 'bookings_updated',
    name: 'Several bookings updated',
    trigger:
      'An administrator approves, rejects, confirms or cancels several of one person’s bookings at once, or several of their provisional holds expire together. ' +
      'Replaces the one-booking emails so they get a single email. The detail card is repeated for each booking.',
    subject: 'Update on {{ booking_count }} of your {{ venue_name }} bookings',
    badge: { label: 'Booking update', colour: 'blue' },
    title: 'Here’s an update on your bookings.',
    body: paras(HI, 'We’ve updated {{ booking_count }} of your bookings. Each one is listed below with its new status.'),
    detail_card: lines('Booking: {{ resource_name }}', 'Status: {{ booking_status }}', WHEN, 'Total: {{ booking_cost }}', REF),
    thanks: THANKS,
    footer: FOOTER,
    extra_params: ['booking_count'],
  },
  {
    key: 'payment_reminder',
    name: 'Payment reminder',
    trigger: 'An administrator sends a reminder from the booking page',
    subject: 'Payment reminder for booking {{ booking_reference }}',
    badge: { label: 'Payment due', colour: 'orange' },
    title: 'A quick reminder about payment.',
    body: paras(HI, 'This is a friendly reminder that payment is due for your booking.', '{{ payment_instructions }}', 'Please quote reference {{ booking_reference }} with your payment.'),
    detail_card: lines('Amount due: {{ booking_cost }}', 'Booking: {{ resource_name }}', 'Date: {{ booking_date }}', REF),
    thanks: THANKS,
    footer: FOOTER,
    extra_params: ['payment_instructions'],
  },
  {
    key: 'maintenance_notice',
    name: 'Maintenance notice',
    trigger: 'An administrator notifies customers whose bookings maintenance affects',
    subject: 'Maintenance affecting your booking {{ booking_reference }}',
    badge: { label: 'Maintenance', colour: 'orange' },
    title: 'Some work is planned around your booking.',
    body: paras(
      HI,
      'We have maintenance planned at the venue that affects your booking: {{ maintenance_title }}, {{ maintenance_period }}.',
      '{{ maintenance_message }}',
      'Your booking has not been cancelled. We will be in touch if anything needs to change, or you can contact us to discuss it.',
    ),
    detail_card: lines('Booking: {{ resource_name }}', WHEN, 'Maintenance: {{ maintenance_title }}', REF),
    thanks: THANKS,
    footer: FOOTER,
    extra_params: ['maintenance_title', 'maintenance_period', 'maintenance_message'],
  },
  {
    key: 'organisation_invitation',
    name: 'Organisation invitation',
    trigger: 'An Organisation Manager invites someone',
    subject: '{{ inviter_name }} has invited you to join {{ organisation_name }}',
    badge: { label: 'Invitation', colour: 'blue' },
    title: 'You’re invited to join {{ organisation_name }}.',
    body: paras(
      'Hello,',
      '{{ inviter_name }} has invited you to join {{ organisation_name }} on the {{ venue_name }} booking site as an {{ invitation_role }}.',
      '[Accept or decline]({{ invitation_url }})',
      'This invitation expires on {{ invitation_expiry }}. If you weren’t expecting it, you can ignore this email.',
    ),
    detail_card: '',
    thanks: THANKS,
    footer: FOOTER,
    required: true,
    extra_params: ['organisation_name', 'inviter_name', 'invitation_role', 'invitation_url', 'invitation_expiry'],
  },
  {
    key: 'password_reset',
    name: 'Password reset',
    trigger: 'A user asks to reset their password',
    subject: 'Reset your {{ venue_name }} password',
    title: 'Reset your password.',
    body: paras(
      HI,
      'Use the button below to choose a new password. The link expires in 1 hour.',
      '[Reset password]({{ reset_url }})',
      'If you didn’t ask to reset your password, you can ignore this email.',
    ),
    detail_card: '',
    thanks: THANKS,
    footer: FOOTER,
    required: true,
    extra_params: ['reset_url'],
  },
];

const BOOKING_TEMPLATES = new Set<EmailTemplateKey>([
  'booking_request_received', 'booking_approved', 'booking_rejected', 'booking_confirmation', 'booking_amended',
  'booking_amendment_rejected', 'booking_cancelled', 'provisional_booking', 'provisional_expired', 'payment_reminder', 'maintenance_notice',
  'bookings_updated',
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

const BUTTON = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/;

/** Split text into trimmed, non-empty lines. */
const toLines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * Build an email from its sections. The structure (paragraphs, buttons,
 * "Label: value" rows) is read from the template before any values are filled
 * in, so user-provided values (names, notes) can never add buttons or rows.
 * Values are HTML-escaped in the HTML, *_email values become mailto links and
 * *_url values become links, and line breaks are stripped from the subject.
 * `logo_url` comes from Settings, and `showLogoPlaceholder` marks the logo's
 * place in previews while none is set.
 */
export function renderEmail(
  content: EmailContent & { badge?: TemplateDefinition['badge'] },
  params: Record<string, string>,
  opts: {
    showLogoPlaceholder?: boolean;
    /** One set of values per booking: the detail card is repeated for each, filled from its own values. */
    items?: Record<string, string>[];
  } = {},
): RenderedEmail {
  const valueIn = (p: Record<string, string>) => (key: string) => p[key] ?? '';
  const plainWith = (value: (k: string) => string) => (t: string) => t.replace(PLACEHOLDER, (_, k: string) => value(k));
  const htmlWith = (value: (k: string) => string) => (t: string) =>
    escapeHtml(t).replace(/{{\s*([a-z_]+)\s*}}/g, (_, k: string) => {
      const v = escapeHtml(value(k));
      if (v && k.endsWith('_email')) return `<a href="mailto:${v}" style="color:inherit;text-decoration:underline;">${v}</a>`;
      if (/^https?:\/\//.test(value(k)) && k.endsWith('_url')) return `<a href="${v}" style="color:inherit;text-decoration:underline;word-break:break-all;">${v}</a>`;
      return v;
    });
  const value = valueIn(params);
  const plain = plainWith(value);
  const attr = (t: string) => escapeHtml(plain(t));
  const html = htmlWith(value);

  const subject = content.subject.replace(PLACEHOLDER, (_, k: string) => value(k).replace(/[\r\n]+/g, ' ')).trim();
  const paragraphs = content.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const rows = toLines(content.detail_card).map((l): [string, string] => {
    const i = l.indexOf(':');
    return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : ['', l];
  });

  const body: BodyBlock[] = [];
  const textBody: string[] = [];
  for (const p of paragraphs) {
    const b = BUTTON.exec(p);
    if (b) {
      body.push({ kind: 'button', label: html(b[1]), url: attr(b[2].trim()) });
      textBody.push(`${plain(b[1])}: ${plain(b[2])}`);
    } else {
      const filled = plain(p).trim();
      if (!filled) continue; // e.g. a note that was left blank
      body.push({ kind: 'para', html: toLines(p).map(html).join('<br>') });
      textBody.push(filled);
    }
  }
  // Each card's rows, filled from the email's values or, for a list of bookings, each booking's.
  const cards = (opts.items?.length ? opts.items : [{}]).map((item) => {
    const v = valueIn({ ...params, ...item });
    const p = plainWith(v);
    const h = htmlWith(v);
    const filled = rows.filter(([, val]) => p(val).trim());
    return {
      text: filled.map(([l, val]) => (l ? `${p(l)}: ${p(val)}` : p(val))).join('\n'),
      html: filled.map(([l, val]): [string, string] => [h(l), h(val)]),
    };
  });

  const text = [
    plain(content.title),
    ...textBody,
    ...cards.map((c) => c.text),
    toLines(content.thanks).map(plain).join('\n'),
    toLines(content.footer).map(plain).join('\n'),
  ]
    .filter((t) => t.trim())
    .join('\n\n');

  const htmlOut = emailLayout(
    {
      badge: content.badge,
      title: html(content.title),
      body,
      detailCards: cards.map((c) => c.html),
      thanks: toLines(content.thanks).map(html),
      footer: toLines(content.footer).map(html),
    },
    {
      title: escapeHtml(subject),
      preheader: escapeHtml(preheader(textBody)),
      logoUrl: escapeHtml(value('logo_url')),
      venueName: escapeHtml(value('venue_name')),
      showLogoPlaceholder: opts.showLogoPlaceholder,
    },
  );
  return { subject, text, html: htmlOut };
}

/** The inbox preview line: the first paragraph after the greeting. */
function preheader(paragraphs: string[]): string {
  const flat = paragraphs.map((p) => p.replace(/\s+/g, ' ').trim());
  const line = (/^(hi|hello|dear)\b/i.test(flat[0] ?? '') ? flat[1] : flat[0]) ?? '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
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
  maintenance_title: 'Main Hall floor resurfacing',
  maintenance_period: '6 Jan 2026, 08:00 to 6 Jan 2026, 18:00',
  maintenance_message: 'The hall will be closed while the floor is sanded and sealed.',
  booking_count: '2',
};

/** Example bookings for templates that list several (previews and test emails). */
export function sampleItems(key: EmailTemplateKey): Record<string, string>[] | undefined {
  if (key !== 'bookings_updated') return undefined;
  return [
    { booking_reference: 'SS-ABC123', resource_name: 'Main Hall', booking_status: 'Approved', booking_date: 'Tue, 6 Jan 2026', booking_start_time: '19:00', booking_end_time: '21:00', booking_cost: '£20.00' },
    { booking_reference: 'SS-DEF456', resource_name: 'Kitchen', booking_status: 'Approved', booking_date: 'Tue, 13 Jan 2026', booking_start_time: '19:00', booking_end_time: '21:00', booking_cost: '£6.00' },
  ];
}
