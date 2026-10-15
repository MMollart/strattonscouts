import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { calendarRange, dayPosition, onDay, shiftDate, startOfWeek } from '@shared/calendar';
import { fromLondon } from '@shared/londonTime';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as adminBookings from '../functions/api/admin/bookings';
import * as bookingsApi from '../functions/api/bookings/index';

describe('calendar dates (FR09)', () => {
  it('builds day, week and whole-week month ranges in UK time', () => {
    expect(calendarRange('day', '2027-07-14')).toEqual({ days: ['2027-07-14'], from: '2027-07-13T23:00:00.000Z', to: '2027-07-14T23:00:00.000Z' });
    const week = calendarRange('week', '2027-07-14');
    expect(week.days[0]).toBe('2027-07-12');
    expect(week.days).toHaveLength(7);
    const month = calendarRange('month', '2027-02-10');
    expect(month.days[0]).toBe('2027-02-01'); // a Monday
    expect(month.days[month.days.length - 1]).toBe('2027-02-28'); // a Sunday
    expect(calendarRange('month', '2027-03-10').days).toHaveLength(35);
    expect(startOfWeek('2027-03-28')).toBe('2027-03-22');
  });

  it('moves by view', () => {
    expect(shiftDate('day', '2027-01-31', 1)).toBe('2027-02-01');
    expect(shiftDate('week', '2027-01-31', -1)).toBe('2027-01-24');
    expect(shiftDate('month', '2027-12-15', 1)).toBe('2028-01-01');
    expect(shiftDate('month', '2027-01-15', -1)).toBe('2026-12-01');
  });

  it('positions bookings on the wall clock, including BST and overnight bookings', () => {
    const b = { starts_at: fromLondon('2027-07-14', '09:00'), ends_at: fromLondon('2027-07-14', '12:00') };
    const p = dayPosition(b, '2027-07-14', 6, 24);
    expect(p.top).toBeCloseTo(3 / 18);
    expect(p.height).toBeCloseTo(3 / 18);
    const overnight = { starts_at: fromLondon('2027-07-14', '20:00'), ends_at: fromLondon('2027-07-15', '10:00') };
    expect(onDay(overnight, '2027-07-14')).toBe(true);
    expect(onDay(overnight, '2027-07-15')).toBe(true);
    expect(onDay(overnight, '2027-07-16')).toBe(false);
    expect(dayPosition(overnight, '2027-07-14')).toMatchObject({ continuesAfter: true, continuesBefore: false });
    expect(dayPosition(overnight, '2027-07-14').top + dayPosition(overnight, '2027-07-14').height).toBeCloseTo(1);
    expect(dayPosition(overnight, '2027-07-15')).toMatchObject({ top: 0, continuesBefore: true });
  });
});

describe('admin calendar data (FR09)', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addAdmin(db, 'viewer', 'viewer');
    await addAdmin(db, 'booker', 'booking_admin');
  });
  afterEach(async () => {
    await dispose();
  });

  it('filters by resources, active status and range for every resource at once', async () => {
    const d = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const cookie = await sessionFor(env, 'u1');
    const a = await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', starts_at: `${d}T10:00:00.000Z`, ends_at: `${d}T11:00:00.000Z` } });
    await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_small', starts_at: `${d}T10:00:00.000Z`, ends_at: `${d}T11:00:00.000Z` } });
    await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(a.body.id).run();
    const viewer = await sessionFor(env, 'viewer');
    const base = `/api/admin/bookings?from=${d}T00:00:00.000Z&to=${d}T23:59:59.000Z&limit=2000`;

    const all = await call(adminBookings.onRequestGet, { env, cookie: viewer, path: base });
    expect(all.body).toHaveLength(2);
    expect(all.body[0]).toHaveProperty('series_id');
    expect(all.body[0]).toHaveProperty('resource_id');
    const active = await call(adminBookings.onRequestGet, { env, cookie: viewer, path: `${base}&active_only=1` });
    expect(active.body.map((b: { resource_id: string }) => b.resource_id)).toEqual(['res_small']);
    const main = await call(adminBookings.onRequestGet, { env, cookie: viewer, path: `${base}&resource_ids=res_main,res_kitchen` });
    expect(main.body.map((b: { resource_id: string }) => b.resource_id)).toEqual(['res_main']);
    const byCustomer = await call(adminBookings.onRequestGet, { env, cookie: viewer, path: `${base}&user_id=u1` });
    expect(byCustomer.body).toHaveLength(2);
  });

  it('is read-only for viewers: they cannot create bookings from the calendar', async () => {
    const d = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const slot = { resource_id: 'res_main', starts_at: `${d}T10:00:00.000Z`, ends_at: `${d}T11:00:00.000Z`, on_behalf_of_user_id: 'u1' };
    expect((await call(bookingsApi.onRequestPost, { env, cookie: await sessionFor(env, 'viewer'), body: slot })).status).toBe(403);
    expect((await call(bookingsApi.onRequestPost, { env, cookie: await sessionFor(env, 'booker'), body: slot })).status).toBe(201);
  });
});
