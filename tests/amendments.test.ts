import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as bookingsApi from '../functions/api/bookings/index';
import * as cancelApi from '../functions/api/bookings/[id]/cancel';
import * as quoteApi from '../functions/api/bookings/[id]/amendments/quote';
import * as amendmentsApi from '../functions/api/bookings/[id]/amendments/index';
import * as withdrawApi from '../functions/api/bookings/[id]/amendments/[amendmentId]';
import * as adminList from '../functions/api/admin/amendments/index';
import * as decideApi from '../functions/api/admin/amendments/[id]';
import * as orgsApi from '../functions/api/organisations/index';

describe('customer booking amendments (FR12)', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;
  let customer: string;
  let admin: string;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addUser(db, 'u2');
    await addAdmin(db, 'booker', 'booking_admin');
    await addAdmin(db, 'viewer', 'viewer');
    customer = await sessionFor(env, 'u1');
    admin = await sessionFor(env, 'booker');
  });
  afterEach(async () => {
    await dispose();
  });

  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const win = (n: number, from: string, to: string) => ({ starts_at: `${day(n)}T${from}:00:00.000Z`, ends_at: `${day(n)}T${to}:00:00.000Z` });
  const book = async (cookie: string, resource = 'res_main', w = win(10, '10', '12'), extra: Record<string, unknown> = {}) =>
    (await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: resource, ...w, ...extra } })).body.id as string;
  const bookingRow = (id: string) => db.prepare('SELECT resource_id, starts_at, ends_at, total_amount_pence, status FROM bookings WHERE id = ?').bind(id).first();

  it('quotes a change with availability and the price difference', async () => {
    const id = await book(customer);
    const q = await call(quoteApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_main', ...win(11, '10', '13') } });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ current_total_pence: 2000, difference_pence: 1000, price: { total_pence: 3000 } });

    // Moving within its own slot is allowed; moving onto someone else's is not.
    expect((await call(quoteApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_main', ...win(10, '11', '13') } })).status).toBe(200);
    await book(await sessionFor(env, 'u2'), 'res_small', win(12, '10', '12'));
    const clash = await call(quoteApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_whole', ...win(12, '09', '11') } });
    expect(clash.status).toBe(409);
    expect(clash.body.details.code).toBe('conflict');
    // Others cannot request changes to this booking.
    expect((await call(quoteApi.onRequestPost, { env, cookie: await sessionFor(env, 'u2'), params: { id }, body: { resource_id: 'res_main', ...win(11, '10', '13') } })).status).toBe(403);
  });

  it('keeps the original booking reserved until an admin approves, then updates it atomically at the agreed price', async () => {
    const id = await book(customer);
    const req = await call(amendmentsApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_small', ...win(11, '14', '17'), note: 'Need more time' } });
    expect(req.status).toBe(201);
    expect(req.body.difference_pence).toBe(1500 - 2000);
    // Only one open request at a time.
    expect((await call(amendmentsApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_main', ...win(13, '10', '12') } })).status).toBe(409);

    // The original slot is still held.
    expect((await call(bookingsApi.onRequestPost, { env, cookie: await sessionFor(env, 'u2'), body: { resource_id: 'res_main', ...win(10, '10', '12') } })).status).toBe(409);
    expect(await bookingRow(id)).toMatchObject({ resource_id: 'res_main', total_amount_pence: 2000 });

    // Prices change after the request; the customer pays what they agreed.
    await db.prepare("UPDATE base_rates SET amount_pence = 9999 WHERE id = 'rate_pr_small_p'").run();

    const pending = await call(adminList.onRequestGet, { env, cookie: admin, path: '/api/admin/amendments' });
    expect(pending.body).toHaveLength(1);
    expect((await call(decideApi.onRequestPost, { env, cookie: await sessionFor(env, 'viewer'), params: { id: req.body.id }, body: { decision: 'approve' } })).status).toBe(403);
    const ok = await call(decideApi.onRequestPost, { env, cookie: admin, params: { id: req.body.id }, body: { decision: 'approve' } });
    expect(ok.status).toBe(200);
    expect(await bookingRow(id)).toMatchObject({ resource_id: 'res_small', starts_at: win(11, '14', '17').starts_at, total_amount_pence: 1500, status: 'confirmed' });
    expect((await db.prepare('SELECT resource_id FROM booking_resources WHERE booking_id = ?').bind(id).first())?.resource_id).toBe('res_small');
    // The original allocation is released.
    expect((await call(bookingsApi.onRequestPost, { env, cookie: await sessionFor(env, 'u2'), body: { resource_id: 'res_main', ...win(10, '10', '12') } })).status).toBe(201);
    // History and email.
    const history = await call(amendmentsApi.onRequestGet, { env, cookie: customer, params: { id } });
    expect(history.body[0]).toMatchObject({ status: 'approved', from_resource_id: 'res_main', to_resource_id: 'res_small', customer_note: 'Need more time' });
    expect((await db.prepare("SELECT COUNT(*) AS c FROM booking_events WHERE booking_id = ? AND event_type = 'amended'").bind(id).first<{ c: number }>())?.c).toBe(1);
    expect(await db.prepare("SELECT template FROM email_events WHERE booking_id = ? AND template = 'booking_amended'").bind(id).first()).toBeTruthy();
    // Decisions are final.
    expect((await call(decideApi.onRequestPost, { env, cookie: admin, params: { id: req.body.id }, body: { decision: 'reject' } })).status).toBe(409);
  });

  it('revalidates on approval and leaves the booking unchanged if the new time was taken', async () => {
    const id = await book(customer);
    const req = await call(amendmentsApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_main', ...win(11, '10', '12') } });
    await book(await sessionFor(env, 'u2'), 'res_whole', win(11, '11', '12'));
    const refused = await call(decideApi.onRequestPost, { env, cookie: admin, params: { id: req.body.id }, body: { decision: 'approve' } });
    expect(refused.status).toBe(409);
    expect(await bookingRow(id)).toMatchObject({ starts_at: win(10, '10', '12').starts_at, total_amount_pence: 2000 });
    expect((await db.prepare('SELECT status FROM booking_amendments WHERE id = ?').bind(req.body.id).first())?.status).toBe('pending');
  });

  it('records rejections, notifies the customer and preserves the booking', async () => {
    const id = await book(customer);
    const req = await call(amendmentsApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_main', ...win(11, '10', '12') } });
    const res = await call(decideApi.onRequestPost, { env, cookie: admin, params: { id: req.body.id }, body: { decision: 'reject', note: 'The hall is being decorated that week.' } });
    expect(res.status).toBe(200);
    expect(await bookingRow(id)).toMatchObject({ starts_at: win(10, '10', '12').starts_at, status: 'confirmed' });
    expect((await db.prepare('SELECT status, decision_note, decided_by FROM booking_amendments WHERE id = ?').bind(req.body.id).first())).toEqual({
      status: 'rejected', decision_note: 'The hall is being decorated that week.', decided_by: 'booker',
    });
    expect(await db.prepare("SELECT template FROM email_events WHERE booking_id = ? AND template = 'booking_amendment_rejected'").bind(id).first()).toBeTruthy();
  });

  it('lets the customer withdraw a request, and closes requests when the booking is cancelled', async () => {
    const id = await book(customer);
    const req = await call(amendmentsApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_main', ...win(11, '10', '12') } });
    expect((await call(withdrawApi.onRequestDelete, { env, cookie: customer, method: 'DELETE', params: { id, amendmentId: req.body.id } })).status).toBe(200);
    const again = await call(amendmentsApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_main', ...win(12, '10', '12') } });
    expect(again.status).toBe(201);
    const mine = await call(bookingsApi.onRequestGet, { env, cookie: customer });
    expect(mine.body[0].has_pending_amendment).toBe(true);
    await call(cancelApi.onRequestPost, { env, cookie: customer, params: { id } });
    expect((await db.prepare('SELECT status FROM booking_amendments WHERE id = ?').bind(again.body.id).first())?.status).toBe('withdrawn');
    expect((await call(amendmentsApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_main', ...win(13, '10', '12') } })).status).toBe(400);
  });

  it('lets organisation managers, but not members, request changes to organisation bookings', async () => {
    const org = await call(orgsApi.onRequestPost, {
      env, cookie: customer,
      body: { name: '1st Stratton', organisation_type_id: 'scout_group', pricing_category_id: 'cat_scouts', contact_email: 'gsl@example.com', contact_phone: '01234 567890' },
    });
    expect(org.status).toBe(201);
    await db.prepare(`INSERT INTO organisation_memberships (organisation_id, user_id, role, created_at, updated_at) VALUES (?, 'u2', 'member', ?, ?)`)
      .bind(org.body.id, new Date().toISOString(), new Date().toISOString()).run();
    const id = await book(customer, 'res_main', win(10, '10', '12'), { organisation_id: org.body.id });
    const member = await sessionFor(env, 'u2');
    expect((await call(amendmentsApi.onRequestGet, { env, cookie: member, params: { id } })).status).toBe(200);
    expect((await call(amendmentsApi.onRequestPost, { env, cookie: member, params: { id }, body: { resource_id: 'res_main', ...win(11, '10', '12') } })).status).toBe(403);
    expect((await call(amendmentsApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_main', ...win(11, '10', '12') } })).status).toBe(201);
  });
});
