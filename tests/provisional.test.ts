import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import { expireProvisionalBookings, provisionalExpiry } from '../functions/_lib/provisional';
import * as bookingsApi from '../functions/api/bookings/index';
import * as bookingApi from '../functions/api/bookings/[id]';
import * as cancelApi from '../functions/api/bookings/[id]/cancel';
import * as decideApi from '../functions/api/admin/bookings/[id]';
import * as expiryApi from '../functions/api/admin/bookings/[id]/expiry';
import * as availabilityApi from '../functions/api/availability';
import * as restrictionsApi from '../functions/api/admin/resources/[id]/restrictions';
import * as settingsApi from '../functions/api/admin/settings';

describe('provisionalExpiry (FR04)', () => {
  it('adds the hold period but never runs past the booking start', () => {
    const now = Date.parse('2027-01-01T10:00:00Z');
    expect(provisionalExpiry(now, 48, '2027-02-01T10:00:00.000Z')).toBe('2027-01-03T10:00:00.000Z');
    expect(provisionalExpiry(now, 48, '2027-01-02T09:00:00.000Z')).toBe('2027-01-02T09:00:00.000Z');
  });
});

describe('provisional bookings against D1 (FR04)', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;
  let admin: string;
  let customer: string;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addUser(db, 'u2');
    await addAdmin(db, 'booker', 'booking_admin');
    await addAdmin(db, 'viewer', 'viewer');
    await addAdmin(db, 'super', 'super_admin');
    admin = await sessionFor(env, 'booker');
    customer = await sessionFor(env, 'u1');
  });
  afterEach(async () => {
    await dispose();
  });

  const inDays = (days: number) => {
    const d = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    return { starts_at: `${d}T10:00:00.000Z`, ends_at: `${d}T12:00:00.000Z` };
  };
  const hold = (cookie: string, extra: Record<string, unknown> = {}) =>
    call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', ...inDays(10), provisional: true, ...extra } });
  const lapse = (id: string) =>
    db.prepare("UPDATE bookings SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute') WHERE id = ?").bind(id).run();
  const status = async (id: string) => (await db.prepare('SELECT status FROM bookings WHERE id = ?').bind(id).first<{ status: string }>())?.status;

  it('reserves the resource with an expiry from the global setting and emails the customer', async () => {
    const res = await hold(customer);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('provisional');
    const hours = (Date.parse(res.body.expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThanOrEqual(48);

    // The hold blocks the same space and the Whole Venue for everyone else.
    const other = await sessionFor(env, 'u2');
    expect((await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_main', ...inDays(10) } })).status).toBe(409);
    expect((await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_whole', ...inDays(10) } })).status).toBe(409);
    const w = inDays(10);
    const avail = await call(availabilityApi.onRequestGet, { env, path: `/api/availability?resource_id=res_main&starts_at=${w.starts_at}&ends_at=${w.ends_at}` });
    expect(avail.body).toMatchObject({ available: false, reason: 'conflict' });

    const email = await db.prepare("SELECT template FROM email_events WHERE booking_id = ?").bind(res.body.id).first();
    expect(email).toEqual({ template: 'provisional_booking' });
  });

  it('uses the resource hold period over the global one, and the admin period over both', async () => {
    await call(settingsApi.onRequestPut, { env, cookie: await sessionFor(env, 'super'), method: 'PUT', body: { values: { provisional_expiry_hours: 24 } } });
    let res = await hold(customer);
    expect(Math.round((Date.parse(res.body.expires_at) - Date.now()) / 3_600_000)).toBe(24);

    await call(restrictionsApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: 'res_small' }, body: { min_notice_minutes: null, max_advance_days: null, provisional_expiry_hours: 6 } });
    res = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_small', ...inDays(10), provisional: true } });
    expect(Math.round((Date.parse(res.body.expires_at) - Date.now()) / 3_600_000)).toBe(6);

    // Customers cannot choose their own hold period; admins can.
    expect((await hold(customer, { ...inDays(11), provisional_expiry_hours: 200 })).status).toBe(403);
    res = await hold(admin, { ...inDays(12), on_behalf_of_user_id: 'u1', provisional_expiry_hours: 72 });
    expect(res.status).toBe(201);
    expect(Math.round((Date.parse(res.body.expires_at) - Date.now()) / 3_600_000)).toBe(72);
  });

  it('releases the resource as soon as the hold lapses, even before the scheduler runs', async () => {
    const res = await hold(customer);
    await lapse(res.body.id);
    expect((await call(bookingApi.onRequestGet, { env, cookie: customer, params: { id: res.body.id } })).body.status).toBe('expired');
    const other = await sessionFor(env, 'u2');
    expect((await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_main', ...inDays(10) } })).status).toBe(201);
  });

  it('expires lapsed holds exactly once, keeping history, however often the job runs', async () => {
    const a = await hold(customer);
    const b = await hold(customer, inDays(11));
    await lapse(a.body.id);

    const runs = await Promise.all([expireProvisionalBookings(env), expireProvisionalBookings(env)]);
    expect(runs[0] + runs[1]).toBe(1);
    expect(await expireProvisionalBookings(env)).toBe(0);

    expect(await status(a.body.id)).toBe('expired');
    expect(await status(b.body.id)).toBe('provisional');
    const events = await db.prepare("SELECT COUNT(*) AS c FROM booking_events WHERE booking_id = ? AND event_type = 'expired'").bind(a.body.id).first<{ c: number }>();
    expect(events?.c).toBe(1);
    const emails = await db.prepare("SELECT COUNT(*) AS c FROM email_events WHERE booking_id = ? AND template = 'provisional_expired'").bind(a.body.id).first<{ c: number }>();
    expect(emails?.c).toBe(1);
    // Still listed in the customer's history.
    const mine = await call(bookingsApi.onRequestGet, { env, cookie: customer });
    expect(mine.body.find((x: { id: string }) => x.id === a.body.id)?.status).toBe('expired');
  });

  it('lets an approver confirm a live hold after revalidation, but never an expired one', async () => {
    const live = await hold(customer);
    expect((await call(decideApi.onRequestPost, { env, cookie: await sessionFor(env, 'viewer'), params: { id: live.body.id }, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(decideApi.onRequestPost, { env, cookie: admin, params: { id: live.body.id }, body: { decision: 'approve' } })).status).toBe(200);
    expect(await status(live.body.id)).toBe('confirmed');
    const email = await db.prepare("SELECT template FROM email_events WHERE booking_id = ? AND template = 'booking_confirmation'").bind(live.body.id).first();
    expect(email).toBeTruthy();

    const lapsed = await hold(customer, inDays(11));
    await lapse(lapsed.body.id);
    const refused = await call(decideApi.onRequestPost, { env, cookie: admin, params: { id: lapsed.body.id }, body: { decision: 'approve' } });
    expect(refused.status).toBe(409);
    expect(refused.body.details.code).toBe('expired');
    expect(await status(lapsed.body.id)).toBe('provisional');
  });

  it('refuses to confirm a lapsed hold once someone else has booked the time', async () => {
    const res = await hold(customer);
    await lapse(res.body.id);
    const other = await sessionFor(env, 'u2');
    expect((await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_main', ...inDays(10) } })).status).toBe(201);
    // Extending the expiry cannot revive it either.
    const later = new Date(Date.now() + 86_400_000).toISOString();
    expect((await call(expiryApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: res.body.id }, body: { expires_at: later } })).status).toBe(409);
    expect((await call(decideApi.onRequestPost, { env, cookie: admin, params: { id: res.body.id }, body: { decision: 'approve' } })).status).toBe(409);
  });

  it('lets a booking manager change a live hold expiry within the booking start', async () => {
    const res = await hold(customer);
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString();
    expect((await call(expiryApi.onRequestPut, { env, cookie: await sessionFor(env, 'viewer'), method: 'PUT', params: { id: res.body.id }, body: { expires_at: later } })).status).toBe(403);
    const ok = await call(expiryApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: res.body.id }, body: { expires_at: later } });
    expect(ok.status).toBe(200);
    expect((await db.prepare('SELECT expires_at FROM bookings WHERE id = ?').bind(res.body.id).first<{ expires_at: string }>())?.expires_at).toBe(later);
    const tooLate = new Date(Date.now() + 20 * 86_400_000).toISOString();
    expect((await call(expiryApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: res.body.id }, body: { expires_at: tooLate } })).status).toBe(400);
    const past = new Date(Date.now() - 60_000).toISOString();
    expect((await call(expiryApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: res.body.id }, body: { expires_at: past } })).status).toBe(400);
  });

  it('lets the customer cancel a live hold', async () => {
    const res = await hold(customer);
    expect((await call(cancelApi.onRequestPost, { env, cookie: customer, params: { id: res.body.id } })).status).toBe(200);
    expect(await status(res.body.id)).toBe('cancelled');
  });

  it('cannot bypass a hold with concurrent requests', async () => {
    const other = await sessionFor(env, 'u2');
    const results = await Promise.all([
      hold(customer),
      call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_main', ...inDays(10) } }),
      call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_whole', ...inDays(10) } }),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  });
});
