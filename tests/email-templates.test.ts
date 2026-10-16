import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { contentTexts, renderEmail, unknownParams, SAMPLE_PARAMS, TEMPLATE_DEFINITIONS, type EmailContent } from '@shared/email-templates';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import { loadTemplate, retryFailedEmails, sendEmail } from '../functions/_lib/email';
import * as templatesApi from '../functions/api/admin/email-templates/index';
import * as templateApi from '../functions/api/admin/email-templates/[key]';
import * as previewApi from '../functions/api/admin/email-templates/[key]/preview';
import * as testApi from '../functions/api/admin/email-templates/[key]/test';
import * as historyApi from '../functions/api/admin/emails';
import * as reminderApi from '../functions/api/admin/bookings/[id]/reminder';
import * as bookingsApi from '../functions/api/bookings/index';
import * as decideApi from '../functions/api/admin/bookings/[id]';

describe('renderEmail (FR06)', () => {
  const section = (over: Partial<EmailContent>): EmailContent => ({ subject: 's', title: 'T', body: 'B', detail_card: '', thanks: '', footer: '', ...over });

  it('substitutes parameters and escapes user content in HTML and subjects', () => {
    const out = renderEmail(
      section({ subject: 'Hello {{ customer_name }}', title: 'For {{ resource_name }}', body: 'Hi {{customer_name}},\n\nNote: {{ decision_note }}' }),
      { customer_name: '<script>x</script>\nInjected: header', decision_note: 'Tom & Jerry', resource_name: '"Hall"' },
    );
    expect(out.subject).toBe('Hello <script>x</script> Injected: header');
    expect(out.text).toContain('Note: Tom & Jerry');
    expect(out.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(out.html).toContain('Tom &amp; Jerry');
    expect(out.html).toContain('For &quot;Hall&quot;</h1>');
    expect(out.html).not.toContain('<script>');
  });

  it('builds title, body, detail card, thanks and footer, in that order', () => {
    const out = renderEmail(
      section({
        title: 'Hello',
        body: 'First para\nsecond line\n\n[Go now]({{ reset_url }})\n\n{{ decision_note }}',
        detail_card: 'Booking: {{ resource_name }}\nTotal: {{ booking_cost }}\nTime: 19:00',
        thanks: 'Thank you,\n{{ venue_name }}',
        footer: 'Questions? {{ contact_email }}\n#PlaceToBelong',
      }),
      { reset_url: 'https://x.example/r?t=1&u=2', resource_name: 'Main Hall', booking_cost: '', venue_name: 'Stratton', contact_email: 'a@b.example', decision_note: '' },
    );
    const order = ['Hello</h1>', 'First para<br>second line', 'Go now</a>', 'Main Hall', 'Stratton</strong>', 'mailto:a@b.example', '#PlaceToBelong'];
    const at = order.map((t) => out.html.indexOf(t));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(out.html).toContain('href="https://x.example/r?t=1&amp;u=2"');
    expect(out.html).not.toContain('Total'); // empty values drop their row
    expect(out.html).toContain('19:00'); // only the first colon splits label from value
    expect(out.text).toBe('Hello\n\nFirst para\nsecond line\n\nGo now: https://x.example/r?t=1&u=2\n\nBooking: Main Hall\nTime: 19:00\n\nThank you,\nStratton\n\nQuestions? a@b.example\n#PlaceToBelong');
  });

  it('never lets values add buttons or detail rows', () => {
    const out = renderEmail(
      section({ body: '{{ customer_name }}', detail_card: 'Name: {{ customer_name }}' }),
      { customer_name: '[Click](https://evil.example)\nFake: row' },
    );
    expect(out.html).not.toContain('href="https://evil.example"');
    expect(out.html).not.toContain('>Fake<');
  });

  it('wraps every email in the branded layout, with the logo only once one is set', () => {
    const def = TEMPLATE_DEFINITIONS.find((t) => t.key === 'booking_request_received')!;
    const params = { ...SAMPLE_PARAMS, venue_name: 'Stratton Scouts', contact_email: 'hello@example.com', logo_url: '' };
    const out = renderEmail(def, params);
    expect(out.html).toMatch(/^<!doctype html>/);
    expect(out.html).toContain('Awaiting approval');
    expect(out.html).toContain('SS-ABC123');
    expect(out.html).toContain('mailto:hello@example.com');
    expect(out.html).not.toContain('<img');
    expect(out.html).not.toContain('Logo goes here');
    expect(out.html).toContain('display:none;max-height:0;overflow:hidden;opacity:0;color:#7413dc;font-size:1px;line-height:1px;">Thanks for getting in touch.');
    expect(renderEmail(def, params, { showLogoPlaceholder: true }).html).toContain('Logo goes here');
    const logo = renderEmail(def, { ...params, logo_url: 'https://cdn.example/logo.png?a=1&b=2' }, { showLogoPlaceholder: true }).html;
    expect(logo).toContain('<img src="https://cdn.example/logo.png?a=1&amp;b=2"');
    expect(logo).not.toContain('Logo goes here');
    const reset = renderEmail(TEMPLATE_DEFINITIONS.find((t) => t.key === 'password_reset')!, params).html;
    expect(reset).toContain('<a href="https://example.com/reset-password?token=sample" style="display:inline-block;');
  });

  it('knows which parameters each template supports', () => {
    expect(unknownParams('booking_confirmation', '{{ booking_reference }} {{ venue_name }} {{ reset_url }} {{ typo }}')).toEqual(['reset_url', 'typo']);
    expect(unknownParams('password_reset', '{{ reset_url }}')).toEqual([]);
    for (const t of TEMPLATE_DEFINITIONS) expect(unknownParams(t.key, ...contentTexts(t))).toEqual([]);
  });
});

const pick = ({ subject, title, body, detail_card, thanks, footer }: EmailContent): EmailContent => ({ subject, title, body, detail_card, thanks, footer });

describe('email templates against D1 (FR06)', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;
  let admin: string;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addAdmin(db, 'super', 'super_admin');
    await addAdmin(db, 'booker', 'booking_admin');
    admin = await sessionFor(env, 'super');
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await dispose();
  });

  const nextWeek = () => {
    const d = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    return { starts_at: `${d}T10:00:00.000Z`, ends_at: `${d}T12:00:00.000Z` };
  };

  it('lets template managers edit, preview, test and reset templates', async () => {
    expect((await call(templatesApi.onRequestGet, { env, cookie: await sessionFor(env, 'booker') })).status).toBe(403);
    const list = await call(templatesApi.onRequestGet, { env, cookie: admin });
    expect(list.body.map((t: { key: string }) => t.key)).toContain('payment_reminder');

    const body = { subject: 'Booked: {{ resource_name }}', title: 'See you soon', body: 'Dear {{ customer_name }}, see you on {{ booking_date }}.', detail_card: 'Ref: {{ booking_reference }}', thanks: 'Cheers', footer: '', is_enabled: true };
    const bad = await call(templateApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { key: 'booking_confirmation' }, body: { ...body, footer: 'Hi {{ customer_nme }}' } });
    expect(bad.status).toBe(400);
    expect(bad.body.details.unknown).toEqual(['customer_nme']);
    expect((await call(templateApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { key: 'booking_confirmation' }, body })).status).toBe(200);

    const preview = await call(previewApi.onRequestPost, { env, cookie: admin, params: { key: 'booking_confirmation' }, body });
    expect(preview.body.subject).toBe('Booked: Main Hall');
    expect(preview.body.html).toContain('Dear Alex Example, see you on');
    expect(preview.body.html).toContain('Confirmed'); // the template's status pill
    expect(preview.body.html).toContain('Logo goes here');

    const test = await call(testApi.onRequestPost, { env, cookie: admin, params: { key: 'booking_confirmation' }, body });
    expect(test.body).toMatchObject({ ok: true, to: 'super@example.com' });
    expect(await db.prepare("SELECT subject FROM email_events WHERE recipient = 'super@example.com'").first()).toEqual({ subject: '[Test] Booked: Main Hall' });

    // Real emails use the saved version.
    const booking = await call(bookingsApi.onRequestPost, { env, cookie: await sessionFor(env, 'u1'), body: { resource_id: 'res_main', ...nextWeek() } });
    expect((await db.prepare('SELECT subject, booking_reference FROM email_events WHERE booking_id = ?').bind(booking.body.id).first())).toEqual({
      subject: 'Booked: Main Hall', booking_reference: booking.body.reference,
    });

    expect(await loadTemplate(env, 'booking_confirmation')).toMatchObject({ title: 'See you soon', detail_card: 'Ref: {{ booking_reference }}', footer: '' });

    // A template saved before emails had sections uses the default content but keeps its switch.
    await db.prepare("INSERT INTO email_templates (key, subject, body_text, body_html, is_enabled, updated_at) VALUES ('booking_approved', 'Old', 'Old text', '<p>Old</p>', 0, 'x')").run();
    const def = TEMPLATE_DEFINITIONS.find((t) => t.key === 'booking_approved')!;
    expect(await loadTemplate(env, 'booking_approved')).toMatchObject({ subject: def.subject, title: def.title, body: def.body, is_enabled: false });
    const listed = await call(templatesApi.onRequestGet, { env, cookie: admin });
    expect(listed.body.find((t: { key: string }) => t.key === 'booking_approved')).toMatchObject({ customised: false, is_enabled: false, title: def.title });

    expect((await call(templateApi.onRequestDelete, { env, cookie: admin, method: 'DELETE', params: { key: 'booking_confirmation' } })).status).toBe(200);
    const reset = await call(templatesApi.onRequestGet, { env, cookie: admin });
    expect(reset.body.find((t: { key: string }) => t.key === 'booking_confirmation')).toMatchObject({ customised: false, subject: TEMPLATE_DEFINITIONS.find((t) => t.key === 'booking_confirmation')!.subject });
  });

  it('does not send disabled templates, and required ones cannot be disabled', async () => {
    const def = TEMPLATE_DEFINITIONS.find((t) => t.key === 'booking_approved')!;
    await call(templateApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { key: 'booking_approved' }, body: { ...pick(def), is_enabled: false } });
    const booking = await call(bookingsApi.onRequestPost, { env, cookie: await sessionFor(env, 'u1'), body: { resource_id: 'res_whole', ...nextWeek() } });
    await call(decideApi.onRequestPost, { env, cookie: await sessionFor(env, 'booker'), params: { id: booking.body.id }, body: { decision: 'approve' } });
    const approved = await db.prepare("SELECT status FROM email_events WHERE booking_id = ? AND template = 'booking_approved'").bind(booking.body.id).first();
    expect(approved).toEqual({ status: 'disabled' });

    const reset = TEMPLATE_DEFINITIONS.find((t) => t.key === 'password_reset')!;
    expect((await call(templateApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { key: 'password_reset' }, body: { ...pick(reset), is_enabled: false } })).status).toBe(400);
  });

  it('records history with the provider reference, retries temporary failures without duplicates', async () => {
    env.EMAIL_PROVIDER = 'resend';
    let calls = 0;
    const responses = [new Response('busy', { status: 503 }), new Response(JSON.stringify({ id: 'resend_123' }), { status: 200 })];
    vi.stubGlobal('fetch', vi.fn(async () => responses[calls++] ?? new Response('{}', { status: 200 })));

    await sendEmail(env, { to: 'u1@example.com', template: 'booking_cancelled', dedupeKey: 'k1', params: { customer_name: 'U', booking_reference: 'SS-1' } });
    let row = await db.prepare("SELECT status, attempts, next_attempt_at, params FROM email_events WHERE dedupe_key = 'k1'").first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(row?.next_attempt_at).toBeTruthy();
    expect(row?.params).toBeTruthy();

    // Not due yet.
    expect(await retryFailedEmails(env)).toBe(0);
    await db.prepare("UPDATE email_events SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE dedupe_key = 'k1'").run();
    const [a, b] = await Promise.all([retryFailedEmails(env), retryFailedEmails(env)]);
    expect(a + b).toBe(1);
    expect(calls).toBe(2);
    row = await db.prepare("SELECT status, attempts, provider_ref, sent_at, params FROM email_events WHERE dedupe_key = 'k1'").first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'sent', attempts: 2, provider_ref: 'resend_123', params: null });
    expect(row?.sent_at).toBeTruthy();

    // The same dedupe key is never sent again.
    expect((await sendEmail(env, { to: 'u1@example.com', template: 'booking_cancelled', dedupeKey: 'k1', params: {} })).status).toBe('duplicate');
    expect(calls).toBe(2);

    const history = await call(historyApi.onRequestGet, { env, cookie: admin, path: '/api/admin/emails?q=SS-1' });
    expect(history.body[0]).toMatchObject({ recipient: 'u1@example.com', template: 'booking_cancelled', status: 'sent', provider_ref: 'resend_123', booking_reference: 'SS-1' });
  });

  it('never stores single-use links for retries and does not retry permanent failures', async () => {
    env.EMAIL_PROVIDER = 'resend';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 422 })));
    await sendEmail(env, { to: 'u1@example.com', template: 'password_reset', dedupeKey: 'pr', params: { reset_url: 'https://x/secret' } });
    expect(await db.prepare("SELECT status, params, next_attempt_at FROM email_events WHERE dedupe_key = 'pr'").first()).toEqual({ status: 'failed', params: null, next_attempt_at: null });
  });

  it('sends payment reminders for confirmed bookings when asked', async () => {
    const booking = await call(bookingsApi.onRequestPost, { env, cookie: await sessionFor(env, 'u1'), body: { resource_id: 'res_main', ...nextWeek() } });
    const res = await call(reminderApi.onRequestPost, { env, cookie: await sessionFor(env, 'booker'), params: { id: booking.body.id } });
    expect(res.body).toMatchObject({ ok: true });
    const again = await call(reminderApi.onRequestPost, { env, cookie: await sessionFor(env, 'booker'), params: { id: booking.body.id } });
    expect(again.body.ok).toBe(true);
    expect((await db.prepare("SELECT COUNT(*) AS c FROM email_events WHERE template = 'payment_reminder'").first<{ c: number }>())?.c).toBe(2);
  });
});
