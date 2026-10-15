import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { createTestEnv } from './helpers/d1';
import { resetGraphTokenCache, sendEmail } from '../functions/_lib/email';

describe('Office 365 email via Microsoft Graph', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;
  let requests: { url: string; init: RequestInit }[];

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    Object.assign(env, { EMAIL_PROVIDER: 'office365', MS_TENANT_ID: 'tenant-1', MS_CLIENT_ID: 'client-1', EMAIL_API_KEY: 'secret', EMAIL_FROM: 'bookings@scouts.example' });
    resetGraphTokenCache();
    requests = [];
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await dispose();
  });

  const stub = (sendStatuses: number[]) => {
    let sends = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (url.includes('login.microsoftonline.com')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      return new Response(null, { status: sendStatuses[sends++] ?? 202, headers: { 'request-id': `req-${sends}` } });
    }));
  };
  const row = (key: string) => db.prepare('SELECT status, provider_ref, next_attempt_at FROM email_events WHERE dedupe_key = ?').bind(key).first<Record<string, unknown>>();

  it('signs in with client credentials, sends from the mailbox and reuses the token', async () => {
    stub([]);
    await sendEmail(env, { to: 'u1@example.com', template: 'booking_cancelled', dedupeKey: 'a', params: { customer_name: 'Sam <b>', booking_reference: 'SS-1' } });
    await sendEmail(env, { to: 'u2@example.com', template: 'booking_cancelled', dedupeKey: 'b', params: { customer_name: 'U', booking_reference: 'SS-2' } });

    expect(requests.map((r) => r.url)).toEqual([
      'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token',
      'https://graph.microsoft.com/v1.0/users/bookings%40scouts.example/sendMail',
      'https://graph.microsoft.com/v1.0/users/bookings%40scouts.example/sendMail',
    ]);
    const form = new URLSearchParams(String(requests[0].init.body));
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'client_credentials', client_id: 'client-1', client_secret: 'secret', scope: 'https://graph.microsoft.com/.default' });
    expect((requests[1].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const message = JSON.parse(String(requests[1].init.body)).message;
    expect(message.toRecipients).toEqual([{ emailAddress: { address: 'u1@example.com' } }]);
    expect(message.body.contentType).toBe('HTML');
    expect(message.body.content).toContain('Sam &lt;b&gt;');
    expect(await row('a')).toMatchObject({ status: 'sent', provider_ref: 'req-1' });
  });

  it('retries throttling and expired tokens, but not refusals', async () => {
    stub([429, 401, 403]);
    for (const key of ['t', 'x', 'f']) await sendEmail(env, { to: 'u1@example.com', template: 'booking_cancelled', dedupeKey: key, params: {} });
    expect((await row('t'))?.next_attempt_at).toBeTruthy();
    expect((await row('x'))?.next_attempt_at).toBeTruthy();
    expect(await row('f')).toMatchObject({ status: 'failed', next_attempt_at: null });
    // The 401 dropped the cached token, so the third send signed in again.
    expect(requests.filter((r) => r.url.includes('login')).length).toBe(2);
  });

  it('records a configuration error without retrying', async () => {
    stub([]);
    env.MS_CLIENT_ID = undefined;
    await sendEmail(env, { to: 'u1@example.com', template: 'booking_cancelled', dedupeKey: 'c', params: {} });
    expect(await row('c')).toMatchObject({ status: 'failed', next_attempt_at: null });
    expect(requests).toHaveLength(0);
  });
});
