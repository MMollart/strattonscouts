import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { describeLength, evaluateLength, nightsBetween } from '@shared/availability-rules';
import { fromLondon } from '@shared/londonTime';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as restrictionsApi from '../functions/api/admin/resources/[id]/restrictions';
import * as bookingsApi from '../functions/api/bookings/index';
import * as availabilityApi from '../functions/api/availability';
import * as calendarApi from '../functions/api/calendar';
import * as resourceApi from '../functions/api/resources/[slug]';

const NONE = { minDurationMinutes: null, maxDurationMinutes: null, minNights: null, maxNights: null };

describe('booking length rules', () => {
  it('counts nights as UK calendar days, across the clock change', () => {
    expect(nightsBetween(fromLondon('2027-06-08', '14:00'), fromLondon('2027-06-08', '22:00'))).toBe(0);
    expect(nightsBetween(fromLondon('2027-06-08', '14:00'), fromLondon('2027-06-09', '11:00'))).toBe(1);
    expect(nightsBetween(fromLondon('2027-10-30', '14:00'), fromLondon('2027-11-01', '11:00'))).toBe(2);
  });

  it('enforces overnight-only, nights and hours', () => {
    const sameDay = { s: fromLondon('2027-06-08', '10:00'), e: fromLondon('2027-06-08', '16:00') };
    const twoNights = { s: fromLondon('2027-06-08', '14:00'), e: fromLondon('2027-06-10', '11:00') };
    const overnight = { ...NONE, minNights: 1 };
    expect(evaluateLength(sameDay.s, sameDay.e, overnight).map((v) => v.message)).toEqual([
      'This resource can only be booked overnight: the booking must end on a later day than it starts.',
    ]);
    expect(evaluateLength(twoNights.s, twoNights.e, overnight)).toEqual([]);
    expect(evaluateLength(twoNights.s, twoNights.e, { ...NONE, maxNights: 1 }).map((v) => v.kind)).toEqual(['max_length']);
    expect(evaluateLength(sameDay.s, sameDay.e, { ...NONE, minDurationMinutes: 8 * 60 }).map((v) => v.kind)).toEqual(['min_length']);
    expect(evaluateLength(sameDay.s, sameDay.e, { ...NONE, maxDurationMinutes: 4 * 60 }).map((v) => v.kind)).toEqual(['max_length']);
    expect(evaluateLength(sameDay.s, sameDay.e, NONE)).toEqual([]);
  });

  it('describes the rules for customers', () => {
    expect(describeLength({ ...NONE, minNights: 1 })).toEqual(['Overnight bookings only: your booking must end on a later day than it starts.']);
    expect(describeLength({ ...NONE, minNights: 2, maxNights: 7, minDurationMinutes: 120 })).toEqual(['Book for 2 to 7 nights.', 'Book for at least 2 hours.']);
  });
});

describe('booking length against D1', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;
  let admin: string;
  let customer: string;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addAdmin(db, 'booker', 'booking_admin');
    admin = await sessionFor(env, 'booker');
    customer = await sessionFor(env, 'u1');
    // Camping: overnight only, arrive from 14:00, leave by 11:00.
    const res = await call(restrictionsApi.onRequestPut, {
      env, cookie: admin, method: 'PUT', params: { id: 'res_camping' },
      body: { min_notice_minutes: null, max_advance_days: null, min_nights: 1, default_start_time: '14:00', default_end_time: '11:00' },
    });
    expect(res.status).toBe(200);
  });
  afterEach(async () => {
    await dispose();
  });

  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const sameDay = { starts_at: fromLondon(day(20), '10:00'), ends_at: fromLondon(day(20), '16:00') };
  const twoNights = { starts_at: fromLondon(day(20), '14:00'), ends_at: fromLondon(day(22), '11:00') };

  it('refuses a same-day Camping booking and accepts an overnight one', async () => {
    const refused = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_camping', ...sameDay } });
    expect(refused.status).toBe(400);
    expect(refused.body.details.violations.map((v: { kind: string }) => v.kind)).toEqual(['min_length']);
    const ok = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_camping', ...twoNights } });
    expect(ok.status).toBe(201);
  });

  it('warns while choosing dates, but never marks calendar slots as too short', async () => {
    const check = await call(availabilityApi.onRequestGet, { env, path: `/api/availability?resource_id=res_camping&starts_at=${sameDay.starts_at}&ends_at=${sameDay.ends_at}` });
    expect(check.body).toMatchObject({ available: false, reason: 'restricted' });
    const cal = await call(calendarApi.onRequestGet, { env, path: `/api/calendar?resource_id=res_camping&from=${day(20)}T00:00:00.000Z&to=${day(21)}T00:00:00.000Z` });
    expect(cal.body.restrictions.length).toBeUndefined();
  });

  it('lets an administrator override it with a recorded reason', async () => {
    const res = await call(bookingsApi.onRequestPost, {
      env, cookie: admin,
      body: { resource_id: 'res_camping', ...sameDay, on_behalf_of_user_id: 'u1', override: { kinds: ['min_length'], reason: 'Day visit agreed with the GSL' } },
    });
    expect(res.status).toBe(201);
    const row = await db.prepare('SELECT rule, reason FROM availability_overrides').first();
    expect(row).toEqual({ rule: 'min_length', reason: 'Day visit agreed with the GSL' });
  });

  it('shows the rules and usual times on the resource page, and keeps them when other limits change', async () => {
    const page = await call(resourceApi.onRequestGet, { env, params: { slug: 'camping' } });
    expect(page.body).toMatchObject({ min_nights: 1, default_start_time: '14:00', default_end_time: '11:00' });
    expect(page.body.length_rules).toEqual(['Overnight bookings only: your booking must end on a later day than it starts.']);
    await call(restrictionsApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: 'res_camping' }, body: { min_notice_minutes: 60, max_advance_days: null } });
    expect((await call(resourceApi.onRequestGet, { env, params: { slug: 'camping' } })).body.min_nights).toBe(1);
    const bad = await call(restrictionsApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: 'res_camping' }, body: { min_notice_minutes: null, max_advance_days: null, min_nights: 3, max_nights: 2 } });
    expect(bad.status).toBe(400);
  });
});
