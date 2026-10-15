import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { evaluateRestrictions, type AvailabilityRule } from '@shared/availability-rules';
import { fromLondon } from '@shared/londonTime';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import { createBookingAtomic } from '../functions/_lib/booking';
import { transitionBooking } from '../functions/_lib/lifecycle';
import * as rulesApi from '../functions/api/admin/availability-rules/index';
import * as restrictionsApi from '../functions/api/admin/resources/[id]/restrictions';
import * as bookingsApi from '../functions/api/bookings/index';
import * as bookingApi from '../functions/api/bookings/[id]';
import * as availabilityApi from '../functions/api/availability';

const rule = (r: Partial<AvailabilityRule>): AvailabilityRule => ({
  id: 'r1', resource_id: 'res_main', rule_type: 'closed', days_of_week: '1', start_time: '18:00', end_time: '21:00',
  valid_from: null, valid_to: null, label: null, ...r,
});
// Tuesday 2027-06-08 (BST, UTC+1).
const tue = (from: string, to: string) => ({ startsAt: fromLondon('2027-06-08', from), endsAt: fromLondon('2027-06-08', to) });
const now = Date.parse('2027-06-01T12:00:00Z');
const evalWith = (w: { startsAt: string; endsAt: string }, rules: AvailabilityRule[], extra = {}) =>
  evaluateRestrictions({ ...w, now, minNoticeMinutes: null, maxAdvanceDays: null, rules, ...extra });

describe('evaluateRestrictions (FR03)', () => {
  it('enforces minimum notice and the advance booking window', () => {
    const soon = { startsAt: '2027-06-02T13:00:00Z', endsAt: '2027-06-02T14:00:00Z' };
    expect(evalWith(soon, [], { minNoticeMinutes: 24 * 60 })).toEqual([]);
    expect(evalWith(soon, [], { minNoticeMinutes: 72 * 60 }).map((v) => v.kind)).toEqual(['min_notice']);
    const far = { startsAt: '2028-06-02T10:00:00Z', endsAt: '2028-06-02T11:00:00Z' };
    expect(evalWith(far, [], { maxAdvanceDays: 365 }).map((v) => v.kind)).toEqual(['max_advance']);
    expect(evalWith(far, [], { maxAdvanceDays: 548 })).toEqual([]);
  });

  it('blocks a recurring weekly window in UK time', () => {
    const r = [rule({})]; // every Tuesday 18:00-21:00
    expect(evalWith(tue('17:00', '18:00'), r)).toEqual([]);
    expect(evalWith(tue('20:30', '22:00'), r).map((v) => v.kind)).toEqual(['recurring_restriction']);
    // Wednesday is unaffected.
    expect(evalWith({ startsAt: fromLondon('2027-06-09', '19:00'), endsAt: fromLondon('2027-06-09', '20:00') }, r)).toEqual([]);
  });

  it('supports overnight windows, all-day rules and seasons', () => {
    // Monday 22:00 to Tuesday 06:00
    const overnight = [rule({ days_of_week: '0', start_time: '22:00', end_time: '06:00' })];
    expect(evalWith(tue('05:00', '07:00'), overnight)).toHaveLength(1);
    const allDay = [rule({ start_time: '00:00', end_time: '00:00' })];
    expect(evalWith(tue('09:00', '10:00'), allDay)).toHaveLength(1);
    const winterOnly = [rule({ start_time: '00:00', end_time: '00:00', valid_from: '2027-11-01', valid_to: '2028-02-28' })];
    expect(evalWith(tue('09:00', '10:00'), winterOnly)).toEqual([]);
  });

  it('requires bookings to fit within opening hours when defined', () => {
    const open = [rule({ rule_type: 'open', days_of_week: '0,1,2,3,4,5,6', start_time: '08:00', end_time: '22:00' })];
    expect(evalWith(tue('09:00', '21:00'), open)).toEqual([]);
    expect(evalWith(tue('21:00', '23:00'), open).map((v) => v.kind)).toEqual(['opening_hours']);
    // Contiguous windows across midnight are merged.
    const late = [...open, rule({ id: 'r2', rule_type: 'open', days_of_week: '0,1,2,3,4,5,6', start_time: '22:00', end_time: '00:00' })];
    expect(evalWith({ startsAt: fromLondon('2027-06-08', '21:00'), endsAt: fromLondon('2027-06-08', '23:30') }, late)).toEqual([]);
  });
});

describe('availability rules against D1 (FR03)', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;
  let admin: string;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addAdmin(db, 'booker', 'booking_admin');
    await addAdmin(db, 'viewer', 'viewer');
    admin = await sessionFor(env, 'booker');
  });
  afterEach(async () => {
    await dispose();
  });

  const nextWeek = () => {
    const d = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    return { starts_at: `${d}T10:00:00.000Z`, ends_at: `${d}T12:00:00.000Z` };
  };

  it('blocks customers inside the notice period and lets an authorised admin override with a recorded reason', async () => {
    expect((await call(restrictionsApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: 'res_main' }, body: { min_notice_minutes: 14 * 1440, max_advance_days: null } })).status).toBe(200);
    const cookie = await sessionFor(env, 'u1');
    const w = nextWeek();
    const refused = await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', ...w } });
    expect(refused.status).toBe(400);
    expect(refused.body.details).toMatchObject({ code: 'restricted', violations: [{ kind: 'min_notice' }] });
    // Customers cannot override.
    expect((await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', ...w, override: { kinds: ['min_notice'], reason: 'please' } } })).status).toBe(403);
    const ok = await call(bookingsApi.onRequestPost, {
      env, cookie: admin,
      body: { resource_id: 'res_main', ...w, on_behalf_of_user_id: 'u1', override: { kinds: ['min_notice'], reason: 'Urgent group meeting agreed by GSL' } },
    });
    expect(ok.status).toBe(201);
    const row = await db.prepare('SELECT rule, admin_id, reason, booking_id FROM availability_overrides').first();
    expect(row).toEqual({ rule: 'min_notice', admin_id: 'booker', reason: 'Urgent group meeting agreed by GSL', booking_id: ok.body.id });
    const detail = await call(bookingApi.onRequestGet, { env, cookie: admin, params: { id: ok.body.id } });
    expect(detail.body.overrides).toHaveLength(1);
    expect((await call(bookingApi.onRequestGet, { env, cookie, params: { id: ok.body.id } })).body.overrides).toBeUndefined();
  });

  it('never lets an override create a conflicting booking or bypass a closure', async () => {
    const w = nextWeek();
    await db.prepare('UPDATE resources SET min_notice_minutes = 30000').run();
    const first = await call(bookingsApi.onRequestPost, { env, cookie: admin, body: { resource_id: 'res_main', ...w, on_behalf_of_user_id: 'u1', override: { kinds: ['min_notice'], reason: 'agreed' } } });
    expect(first.status).toBe(201);
    const clash = await call(bookingsApi.onRequestPost, { env, cookie: admin, body: { resource_id: 'res_whole', ...w, on_behalf_of_user_id: 'u1', override: { kinds: ['min_notice'], reason: 'agreed' } } });
    expect(clash.status).toBe(409);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM availability_overrides').first<{ c: number }>())?.c).toBe(1);
  });

  it('applies recurring restrictions on combined resources through the conflict matrix', async () => {
    // Close the Main Hall every day 00:00-00:00; the Whole Venue is then unavailable too.
    await call(rulesApi.onRequestPost, { env, cookie: admin, body: { resource_id: 'res_main', rule_type: 'closed', days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '00:00', end_time: '00:00' } });
    const w = nextWeek();
    expect(await createBookingAtomic({ env, userId: 'u1', resourceId: 'res_whole', startsAt: w.starts_at, endsAt: w.ends_at, actorId: 'u1' })).toMatchObject({ ok: false, code: 'restricted' });
    // Another individual resource is unaffected.
    expect((await createBookingAtomic({ env, userId: 'u1', resourceId: 'res_small', startsAt: w.starts_at, endsAt: w.ends_at, actorId: 'u1' })).ok).toBe(true);
    const avail = await call(availabilityApi.onRequestGet, { env, path: `/api/availability?resource_id=res_main&starts_at=${w.starts_at}&ends_at=${w.ends_at}` });
    expect(avail.body).toMatchObject({ available: false, reason: 'restricted' });
  });

  it('leaves existing bookings intact when rules change', async () => {
    const w = nextWeek();
    const b = await createBookingAtomic({ env, userId: 'u1', resourceId: 'res_field', startsAt: w.starts_at, endsAt: w.ends_at, actorId: 'u1' });
    await call(rulesApi.onRequestPost, { env, cookie: admin, body: { resource_id: 'res_field', rule_type: 'closed', days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: '00:00', end_time: '00:00' } });
    // Still active and can still be approved.
    expect(await transitionBooking(env, { bookingId: b.ok ? b.bookingId : '', to: 'confirmed', actorId: 'booker', actorIsAdmin: true })).toEqual({ ok: true });
  });

  it('only lets availability managers change rules', async () => {
    const viewer = await sessionFor(env, 'viewer');
    expect((await call(rulesApi.onRequestPost, { env, cookie: viewer, body: { resource_id: 'res_main', rule_type: 'closed', days_of_week: [1], start_time: '18:00', end_time: '21:00' } })).status).toBe(403);
    expect((await call(rulesApi.onRequestGet, { env, cookie: viewer })).status).toBe(200);
    expect((await call(rulesApi.onRequestPost, { env, cookie: admin, body: { resource_id: 'res_main', rule_type: 'closed', days_of_week: [], start_time: '18:00', end_time: '21:00' } })).status).toBe(400);
  });
});
