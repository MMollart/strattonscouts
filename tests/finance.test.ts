import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import { allocate, resolvePeriod, usageDays } from '@shared/finance';
import * as financeApi from '../functions/api/admin/finance/index';
import * as exportApi from '../functions/api/admin/finance/export';

describe('allocating value to days (FR10 §4.4)', () => {
  it('splits pence in proportion and always adds up to the total', () => {
    expect(allocate(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocate(1, [1, 1])).toEqual([1, 0]);
    expect(allocate(0, [3, 4])).toEqual([0, 0]);
    expect(allocate(999, [0, 0])).toEqual([999, 0]);
    for (const total of [1, 7, 1999, 123457]) expect(allocate(total, [5, 3, 11, 1]).reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('allocates a booking across the UK days it uses, by time', () => {
    // 18:00 on 1 March to 06:00 on 3 March (GMT): 6h, 24h and 6h.
    expect(usageDays('2027-03-01T18:00:00.000Z', '2027-03-03T06:00:00.000Z', 3600)).toEqual([
      { day: '2027-03-01', pence: 600 },
      { day: '2027-03-02', pence: 2400 },
      { day: '2027-03-03', pence: 600 },
    ]);
    // In summer time, 23:30 UK on 1 July is 22:30 UTC: the booking starts on 1 July, not 2 July.
    expect(usageDays('2027-07-01T22:30:00.000Z', '2027-07-01T23:30:00.000Z', 1000)).toEqual([
      { day: '2027-07-01', pence: 500 },
      { day: '2027-07-02', pence: 500 },
    ]);
    // The day the clocks go forward has 23 hours.
    // 28 March 2027 runs from 00:00 GMT to 23:00 UTC, so a day-long booking in UTC spills an hour into 29 March.
    expect(usageDays('2027-03-28T00:00:00.000Z', '2027-03-29T00:00:00.000Z', 2400)).toEqual([
      { day: '2027-03-28', pence: 2300 },
      { day: '2027-03-29', pence: 100 },
    ]);
    expect(usageDays('2027-03-01T10:00:00.000Z', '2027-03-01T10:00:00.000Z', 500)).toEqual([{ day: '2027-03-01', pence: 500 }]);
  });
});

describe('report periods (FR10 §4.3)', () => {
  it('resolves presets in UK time', () => {
    const today = '2027-01-15';
    expect(resolvePeriod('this_month', null, null, today)).toMatchObject({ from: '2027-01-01', to: '2027-01-31', startIso: '2027-01-01T00:00:00.000Z' });
    expect(resolvePeriod('last_month', null, null, today)).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
    expect(resolvePeriod('this_year', null, null, today)).toMatchObject({ from: '2027-01-01', to: '2027-12-31', endIso: '2028-01-01T00:00:00.000Z' });
    expect(resolvePeriod('last_year', null, null, today)).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
    // A summer month starts at midnight BST, 23:00 UTC the day before.
    expect(resolvePeriod('custom', '2027-07-01', '2027-07-31', today)).toMatchObject({ startIso: '2027-06-30T23:00:00.000Z', endIso: '2027-07-31T23:00:00.000Z' });
    expect(resolvePeriod('custom', '2027-07-31', '2027-07-01', today)).toHaveProperty('error');
    expect(resolvePeriod('custom', null, null, today)).toHaveProperty('error');
  });
});

describe('booking value report (FR10)', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addAdmin(db, 'super', 'super_admin');
    await addAdmin(db, 'booker', 'booking_admin');
    await addAdmin(db, 'viewer', 'viewer');
    await db.prepare(
      `INSERT INTO organisations (id, name, organisation_type_id, pricing_category_id, contact_email, created_by, created_at, updated_at)
       VALUES ('org1', '1st Stratton Cubs', (SELECT id FROM organisation_types LIMIT 1), 'cat_scouts', 'a@example.com', 'u1', '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')`,
    ).run();
    let n = 0;
    const add = (o: { status: string; resource?: string; starts: string; ends: string; total: number; base?: number; org?: string; created?: string; expires?: string }) =>
      db.prepare(
        `INSERT INTO bookings (id, reference, user_id, resource_id, starts_at, ends_at, status, category_id, pricing_model, unit_price_pence, total_amount_pence,
                               base_amount_pence, discount_pence, organisation_id, expires_at, created_at, updated_at)
         VALUES (?, ?, 'u1', ?, ?, ?, ?, 'cat_scouts', 'hourly', 0, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(`bk${++n}`, `SS-T${n}`, o.resource ?? 'res_main', o.starts, o.ends, o.status, o.total, o.base ?? o.total, (o.base ?? o.total) - o.total,
        o.org ?? null, o.expires ?? null, o.created ?? '2027-01-02T00:00:00.000Z', '2027-01-02T00:00:00.000Z').run();
    // March 2027 (GMT).
    await add({ status: 'confirmed', starts: '2027-03-10T10:00:00.000Z', ends: '2027-03-10T12:00:00.000Z', total: 2000, base: 4000, org: 'org1' });
    await add({ status: 'confirmed', resource: 'res_kitchen', starts: '2027-03-11T10:00:00.000Z', ends: '2027-03-11T11:00:00.000Z', total: 0, base: 1000 });
    await add({ status: 'pending_approval', resource: 'res_field', starts: '2027-03-12T10:00:00.000Z', ends: '2027-03-12T12:00:00.000Z', total: 3000 });
    await add({ status: 'provisional', starts: '2027-03-13T10:00:00.000Z', ends: '2027-03-13T12:00:00.000Z', total: 1500, expires: '2099-01-01T00:00:00.000Z' });
    await add({ status: 'provisional', starts: '2027-03-14T10:00:00.000Z', ends: '2027-03-14T12:00:00.000Z', total: 700, expires: '2020-01-01T00:00:00.000Z' });
    await add({ status: 'cancelled', starts: '2027-03-15T10:00:00.000Z', ends: '2027-03-15T12:00:00.000Z', total: 900 });
    await add({ status: 'rejected', resource: 'res_field', starts: '2027-03-16T10:00:00.000Z', ends: '2027-03-16T12:00:00.000Z', total: 800 });
    // Camping over the end of March: 31 March 12:00 to 2 April 12:00, 48h, £96. 12h in March.
    await add({ status: 'confirmed', resource: 'res_camping', starts: '2027-03-31T12:00:00.000Z', ends: '2027-04-02T11:00:00.000Z', total: 9600, created: '2027-02-20T09:00:00.000Z' });
    // Outside March.
    await add({ status: 'confirmed', starts: '2027-04-10T10:00:00.000Z', ends: '2027-04-10T12:00:00.000Z', total: 5000 });
  });
  afterEach(async () => {
    await dispose();
  });

  const march = '/api/admin/finance?period=custom&from=2027-03-01&to=2027-03-31';
  const report = async (path = march, who = 'booker') => call(financeApi.onRequestGet, { env, cookie: await sessionFor(env, who), path });

  it('keeps confirmed, provisional, pending and cancelled values separate', async () => {
    const r = await report();
    expect(r.status).toBe(200);
    expect(r.body.note).toMatch(/not payments received/);
    const camping = r.body.by_resource.find((x: { key: string }) => x.key === 'res_camping').totals.confirmed.value_pence;
    // 11 of the camping booking's 47 hours fall in March (UK midnight is 23:00 UTC in summer time).
    expect(camping).toBe(Math.round((9600 * 11) / 47));
    expect(r.body.totals.confirmed).toMatchObject({ value_pence: 2000 + 0 + camping, count: 3 });
    expect(r.body.totals.pending_approval).toMatchObject({ value_pence: 3000, count: 1, average_pence: 3000 });
    expect(r.body.totals.provisional).toMatchObject({ value_pence: 1500, count: 1 });
    expect(r.body.totals.expired).toMatchObject({ value_pence: 700, count: 1 });
    expect(r.body.totals.cancelled).toMatchObject({ value_pence: 900, count: 1 });
    expect(r.body.totals.rejected).toMatchObject({ value_pence: 800, count: 1 });
    expect(r.body.totals.confirmed.average_pence).toBe(Math.round((2000 + camping) / 3));
  });

  it('reconciles: April gets the rest of the camping booking, and the parts add up to its total', async () => {
    const m = await report();
    const a = await report('/api/admin/finance?period=custom&from=2027-04-01&to=2027-04-30');
    const part = (r: typeof m) => r.body.by_resource.find((x: { key: string }) => x.key === 'res_camping').totals.confirmed.value_pence;
    expect(part(m) + part(a)).toBe(9600);
    // The chart adds up to the totals.
    const sum = m.body.series.points.reduce((s: number, p: { confirmed: number }) => s + p.confirmed, 0);
    expect(sum).toBe(m.body.totals.confirmed.value_pence);
    expect(m.body.series.unit).toBe('day');
    expect(m.body.series.points).toHaveLength(31);
  });

  it('can count value on the booking date instead', async () => {
    const r = await report('/api/admin/finance?period=custom&from=2027-02-01&to=2027-02-28&basis=booked');
    expect(r.body.totals.confirmed).toMatchObject({ value_pence: 9600, count: 1 });
  });

  it('reports discounts and free bookings, and breaks down by price group and organisation', async () => {
    const r = await report();
    expect(r.body.discounts).toMatchObject({ total_discount_pence: 2000 + 1000, discounted_count: 1, free_count: 1 });
    expect(r.body.by_category.map((c: { label: string }) => c.label)).toEqual(['Scouts']);
    const orgs = r.body.by_organisation.map((o: { key: string; label: string; totals: { confirmed: { value_pence: number } } }) => [o.key, o.label, o.totals.confirmed.value_pence]);
    expect(orgs).toContainEqual(['org1', '1st Stratton Cubs', 2000]);
    expect(orgs.find((o: string[]) => o[0] === 'none')[1]).toBe('Personal bookings');

    const one = await report(`${march}&organisation_id=org1`);
    expect(one.body.totals.confirmed).toMatchObject({ value_pence: 2000, count: 1 });
    const year = await report('/api/admin/finance?period=custom&from=2027-01-01&to=2027-12-31');
    expect(year.body.series.unit).toBe('month');
    expect(year.body.totals.confirmed.value_pence).toBe(2000 + 9600 + 5000);
  });

  it('exports the filtered bookings as CSV for Super and Booking Admins only', async () => {
    const res = await call(exportApi.onRequestGet, { env, cookie: await sessionFor(env, 'booker'), path: `${march.replace('/finance?', '/finance/export?')}&resource_id=res_main` });
    expect(res.status).toBe(200);
    const lines = String(res.body).trim().split('\r\n');
    expect(lines[0]).toContain('Booking reference');
    expect(lines).toHaveLength(1 + 4); // confirmed, provisional, expired, cancelled on the Main Hall in March
    expect(lines.find((l) => l.startsWith('"SS-T1",'))).toContain(',40,20,20,20,');
    expect((await call(exportApi.onRequestGet, { env, cookie: await sessionFor(env, 'viewer'), path: march })).status).toBe(403);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'finance.exported'").first<{ n: number }>())?.n).toBe(1);
  });

  it('lets Viewers see the report but not customers', async () => {
    expect((await report(march, 'viewer')).status).toBe(200);
    expect((await report(march, 'u1')).status).toBe(403);
    expect((await report('/api/admin/finance?period=custom&from=2027-03-31&to=2027-03-01')).status).toBe(400);
  });
});
