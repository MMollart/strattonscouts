import type { Env } from './http';
import { newId, now } from './http';
import { getSetting } from './settings';
import { renderEmail, templateDefinition, type EmailTemplateKey, type RenderedEmail } from '@shared/email-templates';

export type EmailTemplate = EmailTemplateKey;

/** A template's current content: the administrator's version if saved, otherwise the default. */
export async function loadTemplate(env: Env, key: EmailTemplateKey): Promise<{ subject: string; body_text: string; body_html: string | null; is_enabled: boolean }> {
  const def = templateDefinition(key);
  const row = await env.DB.prepare('SELECT subject, body_text, body_html, is_enabled FROM email_templates WHERE key = ?')
    .bind(key)
    .first<{ subject: string; body_text: string; body_html: string | null; is_enabled: number }>();
  return {
    subject: row?.subject ?? def?.subject ?? '',
    body_text: row?.body_text ?? def?.body_text ?? '',
    body_html: row?.body_html ?? null,
    // Required templates are always sent.
    is_enabled: def?.required ? true : row ? !!row.is_enabled : true,
  };
}

/** Parameters every email can use, merged under the caller's own. */
export async function commonParams(env: Env, to: string): Promise<Record<string, string>> {
  return {
    customer_email: to,
    venue_name: await getSetting(env, 'venue_name'),
    contact_email: await getSetting(env, 'contact_email'),
    payment_instructions: await getSetting(env, 'payment_instructions'),
  };
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

export const MAX_EMAIL_ATTEMPTS = 5;

/** Minutes to wait before retry n (1-based): 5, 10, 20, 40. */
function retryDelayMinutes(attempt: number): number {
  return 5 * 2 ** (attempt - 1);
}

type DeliveryResult = { status: 'sent'; providerRef: string | null } | { status: 'failed'; error: string; retryable: boolean };

/** Cached Microsoft Graph app token, reused until shortly before it expires. */
let graphToken: { key: string; token: string; expiresAt: number } | null = null;

/** For tests: forget the cached Graph token. */
export function resetGraphTokenCache(): void {
  graphToken = null;
}

/**
 * An app-only token for Microsoft Graph (client credentials grant). The app
 * registration needs the Mail.Send application permission; EMAIL_API_KEY
 * holds its client secret.
 */
async function graphAccessToken(env: Env): Promise<string> {
  const key = `${env.MS_TENANT_ID}|${env.MS_CLIENT_ID}`;
  if (graphToken && graphToken.key === key && graphToken.expiresAt > Date.now() + 60_000) return graphToken.token;
  if (!env.MS_TENANT_ID || !env.MS_CLIENT_ID || !env.EMAIL_API_KEY) throw new GraphConfigError('Office 365 email is not configured (MS_TENANT_ID, MS_CLIENT_ID and EMAIL_API_KEY are required)');
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.MS_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.MS_CLIENT_ID,
      client_secret: env.EMAIL_API_KEY,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  if (!res.ok) {
    // A wrong or expired secret will not fix itself; an outage might.
    const temporary = res.status === 429 || res.status >= 500;
    const detail = await signInErrorDetail(res);
    throw temporary
      ? new Error(`Office 365 sign-in responded ${res.status}${detail}`)
      : new GraphConfigError(`Office 365 sign-in refused (${res.status})${detail || '; check the app registration and client secret'}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  graphToken = { key, token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

class GraphConfigError extends Error {}

/**
 * Microsoft's own reason for a refused sign-in, such as "invalid_client:
 * AADSTS7000215: Invalid client secret provided...", without the trace and
 * correlation IDs it appends. Empty when the body has none.
 */
async function signInErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; error_description?: string };
    const description = (body.error_description ?? '').split(/\r?\n|Trace ID:/)[0].trim();
    const detail = [body.error, description].filter(Boolean).join(': ');
    return detail ? ` ${detail.slice(0, 400)}` : '';
  } catch {
    return '';
  }
}

/** Send through the EMAIL_FROM mailbox with Microsoft Graph sendMail. */
async function deliverViaGraph(env: Env, to: string, email: RenderedEmail): Promise<DeliveryResult> {
  let token: string;
  try {
    token = await graphAccessToken(env);
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e), retryable: !(e instanceof GraphConfigError) };
  }
  const from = env.EMAIL_FROM ?? '';
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: email.subject,
        body: { contentType: 'HTML', content: email.html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (res.status === 202 || res.ok) return { status: 'sent', providerRef: res.headers.get('request-id') };
  // A rejected token is usually an expired cache entry: drop it and retry later.
  if (res.status === 401) graphToken = null;
  return { status: 'failed', error: `Office 365 responded ${res.status}`, retryable: res.status === 401 || res.status === 429 || res.status >= 500 };
}

/** Hand a rendered email to the configured provider (console in development). */
async function deliver(env: Env, to: string, email: RenderedEmail, idempotencyKey: string, label: string): Promise<DeliveryResult> {
  try {
    const provider = (env.EMAIL_PROVIDER ?? 'console').toLowerCase();
    if (provider === 'office365' || provider === 'graph') {
      return await deliverViaGraph(env, to, email);
    }
    if (provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.EMAIL_API_KEY ?? ''}`,
          'content-type': 'application/json',
          // Lets the provider drop a duplicate if a retry races a slow send.
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ from: env.EMAIL_FROM ?? 'bookings@strattonscouts.example', to, subject: email.subject, text: email.text, html: email.html }),
      });
      if (!res.ok) {
        // Rate limits and provider errors are temporary; other refusals are not.
        return { status: 'failed', error: `provider responded ${res.status}`, retryable: res.status === 429 || res.status >= 500 };
      }
      const body = (await res.json().catch(() => null)) as { id?: string } | null;
      return { status: 'sent', providerRef: body?.id ?? null };
    }
    // console provider (development): log instead of sending. The body is
    // included outside production so reset links can be used locally.
    console.log(`[email:${label}] to=${to} subject="${email.subject}"`);
    if (env.ENVIRONMENT !== 'production') console.log(email.text);
    return { status: 'sent', providerRef: null };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e), retryable: true };
  }
}

/** Record the outcome of an attempt; failed temporary sends are scheduled for retry. */
async function recordOutcome(env: Env, eventId: string, attempt: number, result: DeliveryResult): Promise<void> {
  try {
    if (result.status === 'sent') {
      await env.DB.prepare(
        `UPDATE email_events SET status = 'sent', error = NULL, provider_ref = ?, sent_at = ?, attempts = ?, next_attempt_at = NULL, params = NULL WHERE id = ?`,
      )
        .bind(result.providerRef, now(), attempt, eventId)
        .run();
    } else {
      const retry = result.retryable && attempt < MAX_EMAIL_ATTEMPTS;
      await env.DB.prepare(
        `UPDATE email_events SET status = 'failed', error = ?, attempts = ?, next_attempt_at = ?,
                params = CASE WHEN ? THEN params ELSE NULL END WHERE id = ?`,
      )
        .bind(result.error, attempt, retry ? new Date(Date.now() + retryDelayMinutes(attempt) * 60_000).toISOString() : null, retry ? 1 : 0, eventId)
        .run();
    }
  } catch {
    // Never let email bookkeeping break the caller.
  }
}

/**
 * Send a transactional email using the administrator's template (FR06).
 * Idempotent via dedupeKey: a key that has already been sent, is being sent,
 * or was skipped because its template is disabled is never sent again, while
 * a key whose previous attempt failed may be. Every email is recorded in
 * email_events; failures are retried by the scheduler. Failures are never
 * thrown so that the caller's change is not rolled back.
 */
export async function sendEmail(
  env: Env,
  args: {
    to: string;
    template: EmailTemplate;
    params: Record<string, string>;
    bookingId?: string;
    dedupeKey?: string;
    /** Use this content instead of the saved template (test emails). */
    content?: { subject: string; body_text: string; body_html?: string | null };
  },
): Promise<{ status: 'sent' | 'failed' | 'disabled' | 'duplicate' }> {
  const eventId = newId('eml');
  const dedupeKey = args.dedupeKey ?? eventId;
  const def = templateDefinition(args.template);
  const template = args.content ? { ...args.content, is_enabled: true } : await loadTemplate(env, args.template);
  const params = { ...(await commonParams(env, args.to)), ...args.params };
  const reference = params.booking_reference || null;
  const status = template.is_enabled ? 'sending' : 'disabled';

  // Claim the dedupe key before sending. The upsert only takes over an
  // existing row when its previous attempt failed.
  let attempt = 1;
  try {
    const claim = await env.DB.prepare(
      `INSERT INTO email_events (id, booking_id, recipient, template, dedupe_key, status, error, created_at, subject, booking_reference, attempts, params)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, 1, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET status = excluded.status, error = NULL, attempts = email_events.attempts + 1, params = excluded.params
       WHERE email_events.status = 'failed'
       RETURNING id, attempts`,
    )
      .bind(eventId, args.bookingId ?? null, args.to, args.template, dedupeKey, status, now(), reference, def?.required || args.content ? null : JSON.stringify(args.params))
      .first<{ id: string; attempts: number }>();
    if (!claim) return { status: 'duplicate' };
    attempt = claim.attempts;
    if (!template.is_enabled) return { status: 'disabled' };
    return { status: (await attemptSend(env, claim.id, attempt, args.to, args.template, template, params)).status };
  } catch {
    // If bookkeeping is unavailable, still attempt the send.
    if (!template.is_enabled) return { status: 'disabled' };
    const email = renderEmail(template, params);
    return { status: (await deliver(env, args.to, email, dedupeKey, args.template)).status };
  }
}

async function attemptSend(
  env: Env,
  eventId: string,
  attempt: number,
  to: string,
  key: EmailTemplate,
  template: { subject: string; body_text: string; body_html?: string | null },
  params: Record<string, string>,
): Promise<DeliveryResult> {
  const email = renderEmail(template, params);
  await env.DB.prepare('UPDATE email_events SET subject = ? WHERE id = ?').bind(email.subject, eventId).run();
  const result = await deliver(env, to, email, eventId, key);
  await recordOutcome(env, eventId, attempt, result);
  return result;
}

/**
 * Retry emails whose last attempt failed temporarily and whose retry time has
 * come (run by the scheduler). Each is claimed with a status-guarded UPDATE so
 * overlapping runs never send the same email twice. Returns how many were sent.
 */
export async function retryFailedEmails(env: Env, opts: { limit?: number } = {}): Promise<number> {
  const due = await env.DB.prepare(
    `SELECT id, recipient, template, params, attempts FROM email_events
     WHERE status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? AND params IS NOT NULL AND attempts < ?
     ORDER BY next_attempt_at LIMIT ?`,
  )
    .bind(now(), MAX_EMAIL_ATTEMPTS, opts.limit ?? 50)
    .all<{ id: string; recipient: string; template: EmailTemplate; params: string; attempts: number }>();
  let sent = 0;
  for (const e of due.results) {
    const claim = await env.DB.prepare(
      `UPDATE email_events SET status = 'sending', attempts = attempts + 1, next_attempt_at = NULL WHERE id = ? AND status = 'failed' AND attempts = ?`,
    )
      .bind(e.id, e.attempts)
      .run();
    if (claim.meta.changes !== 1) continue;
    const template = await loadTemplate(env, e.template);
    if (!template.is_enabled) {
      await env.DB.prepare(`UPDATE email_events SET status = 'disabled', params = NULL WHERE id = ?`).bind(e.id).run();
      continue;
    }
    const params = { ...(await commonParams(env, e.recipient)), ...(JSON.parse(e.params) as Record<string, string>) };
    if ((await attemptSend(env, e.id, e.attempts + 1, e.recipient, e.template, template, params)).status === 'sent') sent++;
  }
  return sent;
}
