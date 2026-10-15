import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateOccurrences, describePattern, MAX_OCCURRENCES } from '@shared/recurrence';
import { addDays, fromLondon, toLondon } from '@shared/londonTime';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as bookingsApi from '../functions/api/bookings/index';
import * as previewApi from '../functions/api/series/preview';
import * as seriesApi from '../functions/api/series/index';
import * as seriesGet from '../functions/api/series/[id]';
import * as seriesCancel from '../functions/api/series/[id]/cancel';
import * as occurrencesApi from '../functions/api/admin/series/[id]/occurrences';
import * as cancelApi from '../functions/api/bookings/[id]/cancel';

describe('generateOccurrences (FR05)', () => {
  it('generates daily, weekly and fortnightly dates up to an end date', () => {
    const base = { startDate: '2027-01-05', startTime: '19:00', endTime: '21:00' };
    expect(generateOccurrences({ ...base, frequency: 'daily', untilDate: '2027-01-08' }).map((o) => o.date)).toEqual([
      '2027-01-05', '2027-01-06', '2027-01-07', '2027-01-08',
    ]);
    expect(generateOccurrences({ ...base, frequency: 'weekly', untilDate: '2027-01-26' }).map((o) => o.date)).toEqual([
      '2027-01-05', '2027-01-12', '2027-01-19', '2027-01-26',
    ]);
    expect(generateOccurrences({ ...base, frequency: 'fortnightly', count: 3 }).map((o) => o.date)).toEqual(['2027-01-05', '2027-01-19', '2027-02-02']);
  });

  it('keeps UK wall-clock times across the clocks changing', () => {
    const occ = generateOccurrences({ frequency: 'weekly', startDate: '2027-03-23', startTime: '19:00', endTime: '21:00', count: 2 });
    expect(occ[0].startsAt).toBe('2027-03-23T19:00:00.000Z'); // GMT
    expect(occ[1].startsAt).toBe('2027-03-30T18:00:00.000Z'); // BST
    expect(toLondon(occ[1].startsAt).time).toBe('19:00');
  });

  it('supports monthly by day of month, skipping short months, and by weekday position', () => {
    expect(generateOccurrences({ frequency: 'monthly', monthlyMode: 'day_of_month', startDate: '2027-01-31', startTime: '10:00', endTime: '12:00', count: 3 }).map((o) => o.date))
      .toEqual(['2027-01-31', '2027-03-31', '2027-05-31']);
    // First Monday of every month.
    expect(generateOccurrences({ frequency: 'monthly', monthlyMode: 'nth_weekday', startDate: '2027-02-01', startTime: '10:00', endTime: '12:00', count: 3 }).map((o) => o.date))
      .toEqual(['2027-02-01', '2027-03-01', '2027-04-05']);
    // Last Friday.
    expect(generateOccurrences({ frequency: 'monthly', monthlyMode: 'nth_weekday', startDate: '2027-01-29', startTime: '10:00', endTime: '12:00', count: 2 }).map((o) => o.date))
      .toEqual(['2027-01-29', '2027-02-26']);
    expect(describePattern({ frequency: 'monthly', monthlyMode: 'nth_weekday', startDate: '2027-02-01', startTime: '10:00', endTime: '12:00' }))
      .toBe('The first Monday of every month, 10:00–12:00');
  });

  it('runs overnight occurrences into the next day and caps long series', () => {
    const [o] = generateOccurrences({ frequency: 'weekly', startDate: '2027-06-04', startTime: '18:00', endTime: '10:00', count: 1 });
    expect(o.endsAt).toBe(fromLondon('2027-06-05', '10:00'));
    expect(generateOccurrences({ frequency: 'daily', startDate: '2027-01-01', startTime: '10:00', endTime: '11:00', untilDate: '2030-01-01' })).toHaveLength(MAX_OCCURRENCES);
  });
});

describe('recurring bookings against D1 (FR05)', () => {
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
    customer = await sessionFor(env, 'u1');
    admin = await sessionFor(env, 'booker');
  });
  afterEach(async () => {
    await dispose();
  });

  // Four Tuesdays starting at least two weeks out.
  const firstTuesday = () => {
    let d = toLondon(Date.now() + 14 * 86_400_000).date;
    while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 2) d = addDays(d, 1);
    return d;
  };
  const pattern = (start: string) => ({ resource_id: 'res_main', frequency: 'weekly', start_date: start, start_time: '19:00', end_time: '21:00', count: 4 });

  it('previews every date with availability, reasons and the total cost', async () => {
    const start = firstTuesday();
    const clashDate = addDays(start, 14);
    // Someone else has the Whole Venue on the third Tuesday.
    const other = await sessionFor(env, 'u2');
    expect((await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_small', starts_at: fromLondon(clashDate, '20:00'), ends_at: fromLondon(clashDate, '22:00') } })).status).toBe(201);
    await db.prepare(`INSERT INTO resource_closures (id, resource_id, starts_at, ends_at, reason, created_at) VALUES ('cl1', 'res_whole', ?, ?, 'Maintenance', ?)`)
      .bind(fromLondon(addDays(start, 21), '00:00'), fromLondon(addDays(start, 22), '00:00'), new Date().toISOString()).run();

    const res = await call(previewApi.onRequestPost, { env, cookie: customer, body: pattern(start) });
    expect(res.status).toBe(200);
    // Main Hall and Small Hall do not conflict, so the small hall booking is no clash; the closure on the Whole Venue is.
    expect(res.body.occurrences.map((o: { available: boolean; reason?: string }) => o.reason ?? 'ok')).toEqual(['ok', 'ok', 'ok', 'closure']);
    expect(res.body.available_count).toBe(3);
    expect(res.body.total_pence).toBe(3 * 2 * 1000);
  });

  it('identifies clashes and never creates a partial series without explicit exclusions', async () => {
    const start = firstTuesday();
    const clashDate = addDays(start, 7);
    const other = await sessionFor(env, 'u2');
    await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_whole', starts_at: fromLondon(clashDate, '20:00'), ends_at: fromLondon(clashDate, '23:00') } });

    const preview = await call(previewApi.onRequestPost, { env, cookie: customer, body: pattern(start) });
    expect(preview.body.occurrences[1]).toMatchObject({ date: clashDate, available: false, reason: 'conflict' });

    const refused = await call(seriesApi.onRequestPost, { env, cookie: customer, body: pattern(start) });
    expect(refused.status).toBe(409);
    expect(refused.body.details.occurrences).toHaveLength(4);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE user_id = ?').bind('u1').first<{ c: number }>())?.c).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM recurrence_series').first<{ c: number }>())?.c).toBe(0);

    const ok = await call(seriesApi.onRequestPost, { env, cookie: customer, body: { ...pattern(start), exclude_dates: [clashDate] } });
    expect(ok.status).toBe(201);
    expect(ok.body.booking_ids).toHaveLength(3);
    expect(ok.body.total_pence).toBe(3 * 2000);
    const rows = await db.prepare('SELECT status, series_id, total_amount_pence FROM bookings WHERE series_id = ?').bind(ok.body.id).all();
    expect(rows.results).toHaveLength(3);
    expect(rows.results.every((r) => r.status === 'confirmed')).toBe(true);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM booking_resources br JOIN bookings b ON b.id = br.booking_id WHERE b.series_id = ?').bind(ok.body.id).first<{ c: number }>())?.c).toBe(3);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM booking_events e JOIN bookings b ON b.id = e.booking_id WHERE b.series_id = ?').bind(ok.body.id).first<{ c: number }>())?.c).toBe(3);
    // One email for the series.
    expect((await db.prepare("SELECT COUNT(*) AS c FROM email_events WHERE recipient LIKE 'u1%'").first<{ c: number }>())?.c).toBe(1);
  });

  it('rolls back the whole series if any date is taken concurrently', async () => {
    const start = firstTuesday();
    const other = await sessionFor(env, 'u2');
    const results = await Promise.all([
      call(seriesApi.onRequestPost, { env, cookie: customer, body: pattern(start) }),
      call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_whole', starts_at: fromLondon(addDays(start, 21), '19:30'), ends_at: fromLondon(addDays(start, 21), '20:30') } }),
    ]);
    const seriesRows = (await db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE user_id = ?').bind('u1').first<{ c: number }>())?.c;
    if (results[0].status === 201) {
      expect(results[1].status).toBe(409);
      expect(seriesRows).toBe(4);
    } else {
      expect(results[1].status).toBe(201);
      expect(seriesRows).toBe(0);
    }
  });

  it('follows the resource approval setting and prices each date at its own effective rate', async () => {
    const start = firstTuesday();
    // Price rise from the third occurrence.
    await db.prepare(`UPDATE pricing_rates SET effective_to = ? WHERE id = 'rate_pr_main_s'`).bind(fromLondon(addDays(start, 14), '00:00')).run();
    await db.prepare(
      `INSERT INTO pricing_rates (id, resource_id, category_id, pricing_model, amount_pence, effective_from, effective_to, is_active, created_at, updated_at)
       VALUES ('rate_new', 'res_main', 'cat_scouts', 'hourly', 1200, ?, NULL, 1, ?, ?)`,
    ).bind(fromLondon(addDays(start, 14), '00:00'), new Date().toISOString(), new Date().toISOString()).run();
    const preview = await call(previewApi.onRequestPost, { env, cookie: customer, body: pattern(start) });
    expect(preview.body.occurrences.map((o: { price: { total_pence: number } }) => o.price.total_pence)).toEqual([2000, 2000, 2400, 2400]);

    const camping = await call(seriesApi.onRequestPost, {
      env, cookie: customer,
      body: { resource_id: 'res_field', frequency: 'monthly', start_date: start, start_time: '09:00', end_time: '17:00', count: 2 },
    });
    expect(camping.status).toBe(201);
    expect(camping.body.status).toBe('pending_approval');
  });

  it('lets the customer and admins view the series; admins amend one or future occurrences with revalidation', async () => {
    const start = firstTuesday();
    const created = await call(seriesApi.onRequestPost, { env, cookie: customer, body: pattern(start) });
    const view = await call(seriesGet.onRequestGet, { env, cookie: customer, params: { id: created.body.id } });
    expect(view.status).toBe(200);
    expect(view.body.occurrences).toHaveLength(4);
    expect((await call(seriesGet.onRequestGet, { env, cookie: await sessionFor(env, 'u2'), params: { id: created.body.id } })).status).toBe(403);

    const [b1, b2, b3] = created.body.booking_ids as string[];
    // Customers cannot amend through the admin endpoint.
    expect((await call(occurrencesApi.onRequestPut, { env, cookie: customer, method: 'PUT', params: { id: created.body.id }, body: { scope: 'one', booking_id: b1, start_time: '18:00', end_time: '21:00' } })).status).toBe(403);

    // One occurrence, longer and repriced.
    const one = await call(occurrencesApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: created.body.id }, body: { scope: 'one', booking_id: b1, start_time: '18:00', end_time: '21:00' } });
    expect(one.status).toBe(200);
    const r1 = await db.prepare('SELECT starts_at, total_amount_pence FROM bookings WHERE id = ?').bind(b1).first<{ starts_at: string; total_amount_pence: number }>();
    expect(r1).toEqual({ starts_at: fromLondon(start, '18:00'), total_amount_pence: 3000 });
    expect((await db.prepare("SELECT COUNT(*) AS c FROM booking_events WHERE booking_id = ? AND event_type = 'amended'").bind(b1).first<{ c: number }>())?.c).toBe(1);

    // A clash on the fourth date blocks the whole "future" change.
    const other = await sessionFor(env, 'u2');
    await call(bookingsApi.onRequestPost, { env, cookie: other, body: { resource_id: 'res_main', starts_at: fromLondon(addDays(start, 21), '17:00'), ends_at: fromLondon(addDays(start, 21), '18:30') } });
    const blocked = await call(occurrencesApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: created.body.id }, body: { scope: 'future', booking_id: b2, start_time: '17:30', end_time: '20:00' } });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.problems).toHaveLength(1);
    expect((await db.prepare('SELECT starts_at FROM bookings WHERE id = ?').bind(b2).first<{ starts_at: string }>())?.starts_at).toBe(fromLondon(addDays(start, 7), '19:00'));

    const future = await call(occurrencesApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: created.body.id }, body: { scope: 'future', booking_id: b2, start_time: '19:00', end_time: '20:00' } });
    expect(future.status).toBe(200);
    expect(future.body.changed).toBe(3);
    expect((await db.prepare('SELECT ends_at FROM bookings WHERE id = ?').bind(b3).first<{ ends_at: string }>())?.ends_at).toBe(fromLondon(addDays(start, 14), '20:00'));
  });

  it('cancels one occurrence, future occurrences or the whole series', async () => {
    const start = firstTuesday();
    const created = await call(seriesApi.onRequestPost, { env, cookie: customer, body: pattern(start) });
    const [b1, b2, b3, b4] = created.body.booking_ids as string[];
    const statusOf = async (id: string) => (await db.prepare('SELECT status FROM bookings WHERE id = ?').bind(id).first<{ status: string }>())?.status;

    expect((await call(cancelApi.onRequestPost, { env, cookie: customer, params: { id: b1 } })).status).toBe(200);
    expect(await statusOf(b2)).toBe('confirmed');

    const future = await call(seriesCancel.onRequestPost, { env, cookie: customer, params: { id: created.body.id }, body: { scope: 'future', from_booking_id: b3 } });
    expect(future.body).toEqual({ ok: true, cancelled: 2 });
    expect([await statusOf(b2), await statusOf(b3), await statusOf(b4)]).toEqual(['confirmed', 'cancelled', 'cancelled']);
    expect((await db.prepare('SELECT status FROM recurrence_series WHERE id = ?').bind(created.body.id).first<{ status: string }>())?.status).toBe('active');

    const all = await call(seriesCancel.onRequestPost, { env, cookie: admin, params: { id: created.body.id }, body: { scope: 'all' } });
    expect(all.body.cancelled).toBe(1);
    expect((await db.prepare('SELECT status FROM recurrence_series WHERE id = ?').bind(created.body.id).first<{ status: string }>())?.status).toBe('cancelled');
    expect((await call(seriesCancel.onRequestPost, { env, cookie: admin, params: { id: created.body.id }, body: { scope: 'all' } })).status).toBe(400);
  });
});
