import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as bookingsApi from '../functions/api/bookings/index';
import * as bookingApi from '../functions/api/bookings/[id]';
import * as decideBookingApi from '../functions/api/admin/bookings/[id]';
import * as cancelApi from '../functions/api/bookings/[id]/cancel';
import * as amendApi from '../functions/api/bookings/[id]/amendments/index';
import * as decideAmendmentApi from '../functions/api/admin/amendments/[id]';
import * as invoicesApi from '../functions/api/admin/bookings/[id]/invoices';

describe('several resources in one booking', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;
  let cookie: string;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addUser(db, 'u2');
    await addAdmin(db, 'booker', 'booking_admin');
    cookie = await sessionFor(env, 'u1');
  });
  afterEach(async () => {
    await dispose();
  });

  const slot = () => {
    const d = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    return { starts_at: `${d}T10:00:00.000Z`, ends_at: `${d}T12:00:00.000Z` };
  };
  const count = async () => (await db.prepare('SELECT COUNT(*) AS c FROM bookings').first<{ c: number }>())!.c;

  it('makes one booking, with one reference, holding every resource', async () => {
    const w = slot();
    const res = await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', additional_resource_ids: ['res_kitchen', 'res_field'], ...w } });
    expect(res.status).toBe(201);
    expect(res.body.resource_ids).toEqual(['res_main', 'res_kitchen', 'res_field']);
    // The Event Field needs approval, so the whole booking waits for it.
    expect(res.body.status).toBe('pending_approval');
    expect(await count()).toBe(1);

    // Each resource keeps its own price (Scouts: main hall 1000/h, kitchen 300/h); the booking's total is their sum.
    const lines = await db.prepare('SELECT resource_id, total_amount_pence FROM booking_resources WHERE booking_id = ? ORDER BY resource_id').bind(res.body.id).all<{ resource_id: string; total_amount_pence: number }>();
    expect(lines.results.map((l) => l.resource_id)).toEqual(['res_field', 'res_kitchen', 'res_main']);
    const byResource = Object.fromEntries(lines.results.map((l) => [l.resource_id, l.total_amount_pence]));
    expect(byResource).toMatchObject({ res_main: 2000, res_kitchen: 600 });
    expect(res.body.total_amount_pence).toBe(lines.results.reduce((n, l) => n + l.total_amount_pence, 0));

    // One email for the booking, naming every resource.
    const emails = await db.prepare('SELECT template, subject FROM email_events').all<{ template: string; subject: string }>();
    expect(emails.results).toEqual([{ template: 'booking_request_received', subject: expect.stringContaining(res.body.reference) }]);

    const detail = await call(bookingApi.onRequestGet, { env, cookie, params: { id: res.body.id } });
    expect(detail.body.resource_name).toBe('Event Field, Kitchen, Main Hall');
    expect(detail.body.resources.map((r: { resource_name: string; total_amount_pence: number }) => [r.resource_name, r.total_amount_pence])).toEqual([
      ['Event Field', byResource.res_field], ['Kitchen', 600], ['Main Hall', 2000],
    ]);

    // Every resource is now taken for that time.
    const other = await sessionFor(env, 'u2');
    expect((await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_kitchen', ...w } })).status).toBe(409);
    expect((await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_small', ...w } })).status).toBe(201);
  });

  it('books nothing when any resource is unavailable', async () => {
    const w = slot();
    await call(bookingsApi.onRequestPost, { env, cookie: await sessionFor(env, 'u2'), body: { resource_id: 'res_kitchen', ...w } });
    const before = await count();
    const res = await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', additional_resource_ids: ['res_kitchen'], ...w } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Kitchen/);
    expect(await count()).toBe(before);
  });

  it('refuses resources that include each other', async () => {
    const res = await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_whole', additional_resource_ids: ['res_main'], ...slot() } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Main Hall is part of Whole Venue, so they cannot be booked together. Whole Venue already includes it.');
    expect(await count()).toBe(0);
  });

  it('ignores a resource listed twice', async () => {
    const res = await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', additional_resource_ids: ['res_main'], ...slot() } });
    expect(res.status).toBe(201);
    expect(res.body.resource_ids).toEqual(['res_main']);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM booking_resources').first<{ c: number }>())?.c).toBe(1);
  });

  const resourcesOf = async (id: string) =>
    (await db.prepare('SELECT resource_id FROM booking_resources WHERE booking_id = ? ORDER BY resource_id').bind(id).all<{ resource_id: string }>()).results.map((r) => r.resource_id);

  it('approves, invoices and cancels the booking as a whole', async () => {
    const w = slot();
    const booking = (await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', additional_resource_ids: ['res_field'], ...w } })).body;
    const admin = await sessionFor(env, 'booker');
    expect((await call(decideBookingApi.onRequestPost, { env, cookie: admin, params: { id: booking.id }, body: { decision: 'approve' } })).status).toBe(200);
    const approved = await db.prepare("SELECT subject FROM email_events WHERE template = 'booking_approved'").all<{ subject: string }>();
    expect(approved.results).toHaveLength(1);

    // One invoice with a line per resource.
    const invoice = await call(invoicesApi.onRequestPost, { env, method: 'POST', cookie: admin, params: { id: booking.id } });
    expect(invoice.status).toBe(200);
    expect(invoice.body.invoice.amount_pence).toBe(booking.total_amount_pence);
    expect(invoice.body.invoice.lines.map((l: { resource_name: string }) => l.resource_name)).toEqual(['Event Field', 'Main Hall']);

    // Cancelling frees every resource.
    expect((await call(cancelApi.onRequestPost, { env, cookie, params: { id: booking.id } })).status).toBe(200);
    const other = await sessionFor(env, 'u2');
    expect((await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_main', ...w } })).status).toBe(201);
  });

  it('changes which resources a booking holds through a change request', async () => {
    const w = slot();
    const booking = (await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', additional_resource_ids: ['res_small'], ...w } })).body;
    expect(booking.total_amount_pence).toBe(2000 + 1000);

    // Swap the Small Hall for the Kitchen.
    const request = await call(amendApi.onRequestPost, { env, cookie, params: { id: booking.id }, body: { resource_id: 'res_main', resource_ids: ['res_main', 'res_kitchen'], ...w } });
    expect(request.status).toBe(201);
    expect(request.body.to_total_pence).toBe(2000 + 600);
    const listed = await call(amendApi.onRequestGet, { env, cookie, params: { id: booking.id } });
    expect(listed.body[0]).toMatchObject({ from_resource_name: 'Main Hall, Small Hall', to_resource_name: 'Kitchen, Main Hall' });

    const admin = await sessionFor(env, 'booker');
    expect((await call(decideAmendmentApi.onRequestPost, { env, cookie: admin, params: { id: request.body.id }, body: { decision: 'approve' } })).status).toBe(200);
    expect(await resourcesOf(booking.id)).toEqual(['res_kitchen', 'res_main']);
    const after = await call(bookingApi.onRequestGet, { env, cookie, params: { id: booking.id } });
    expect(after.body).toMatchObject({ reference: booking.reference, resource_name: 'Kitchen, Main Hall', total_amount_pence: 2600 });

    // The Small Hall is free again; the Kitchen is now taken.
    const other = await sessionFor(env, 'u2');
    expect((await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_small', ...w } })).status).toBe(201);
    expect((await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_kitchen', ...w } })).status).toBe(409);
  });

  it('refuses a change that would add a resource already booked', async () => {
    const w = slot();
    await call(bookingsApi.onRequestPost, { env, cookie: await sessionFor(env, 'u2'), body: { resource_id: 'res_kitchen', ...w } });
    const booking = (await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', ...w } })).body;
    const res = await call(amendApi.onRequestPost, { env, cookie, params: { id: booking.id }, body: { resource_id: 'res_main', resource_ids: ['res_main', 'res_kitchen'], ...w } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Kitchen/);
  });
});
