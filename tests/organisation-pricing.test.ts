import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import { quotePrice } from '../functions/_lib/pricing-engine';
import { createBookingAtomic } from '../functions/_lib/booking';
import * as arrangements from '../functions/api/admin/pricing/organisations/index';
import * as arrangement from '../functions/api/admin/pricing/organisations/[id]';
import * as discounts from '../functions/api/admin/pricing/discounts/index';
import * as quote from '../functions/api/pricing/quote';

let env: Env;
let db: D1Database;
let dispose: () => Promise<void>;
let admin: string;

// Scouts category: Main Hall £10/h, Small Hall £5/h. 2 hours.
const win = { startsAt: '2027-05-01T10:00:00.000Z', endsAt: '2027-05-01T12:00:00.000Z' };

beforeEach(async () => {
  ({ env, db, dispose } = await createTestEnv());
  await addUser(db, 'u1', 'cat_public');
  await addAdmin(db, 'super', 'super_admin');
  admin = await sessionFor(env, 'super');
  const ts = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO organisations (id, name, organisation_type_id, pricing_category_id, contact_email, created_by, created_at, updated_at) VALUES ('org1', 'Group', 'scout_group', 'cat_scouts', 'g@example.org', 'u1', ?, ?)").bind(ts, ts),
    db.prepare("INSERT INTO organisation_memberships (organisation_id, user_id, role, created_at, updated_at) VALUES ('org1', 'u1', 'manager', ?, ?)").bind(ts, ts),
  ]);
});
afterEach(async () => {
  await dispose();
});

function add(body: Record<string, unknown>) {
  return call(arrangements.onRequestPost, { env, cookie: admin, body: { organisation_id: 'org1', effective_from: '2027-01-01T00:00:00Z', ...body } });
}
const orgQuote = (resourceId: string) => quotePrice(env, { resourceId, userId: 'u1', organisationId: 'org1', ...win });

describe('organisation-specific pricing (FR14)', () => {
  it('gives free use of an individual resource', async () => {
    expect((await add({ resource_id: 'res_small', arrangement_type: 'free' })).status).toBe(201);
    expect(await orgQuote('res_small')).toMatchObject({ breakdown: { total_pence: 0, source: 'organisation_free' } });
    // Other resources are unaffected.
    expect(await orgQuote('res_main')).toMatchObject({ breakdown: { total_pence: 2000, source: 'category_rate' } });
    // Personal bookings by the same member are unaffected.
    expect(await quotePrice(env, { resourceId: 'res_small', userId: 'u1', ...win })).toMatchObject({ breakdown: { total_pence: 3000 } });
  });

  it('applies an agreed rate with its own charging model', async () => {
    await add({ resource_id: 'res_main', arrangement_type: 'rate', pricing_model: 'fixed', value: 1500 });
    expect(await orgQuote('res_main')).toMatchObject({ breakdown: { pricing_model: 'fixed', total_pence: 1500, source: 'organisation_rate' } });
  });

  it('applies percentage and fixed discounts to the standard category rate', async () => {
    await add({ arrangement_type: 'percentage', value: 2000 });
    expect(await orgQuote('res_main')).toMatchObject({ breakdown: { base_amount_pence: 2000, discount_pence: 400, total_pence: 1600, source: 'organisation_discount' } });
    await add({ resource_id: 'res_small', arrangement_type: 'fixed_discount', value: 300 });
    // The resource-specific discount beats the all-resources one.
    expect(await orgQuote('res_small')).toMatchObject({ breakdown: { base_amount_pence: 1000, discount_pence: 300, total_pence: 700 } });
  });

  it('follows the precedence order and never stacks with general discounts', async () => {
    await call(discounts.onRequestPost, { env, cookie: admin, body: { name: 'Everyone 50%', discount_type: 'percentage', value: 5000, effective_from: '2027-01-01T00:00:00Z' } });
    await add({ arrangement_type: 'percentage', value: 1000 });
    expect(await orgQuote('res_main')).toMatchObject({ breakdown: { discount_pence: 200, total_pence: 1800 } });
    await add({ resource_id: 'res_main', arrangement_type: 'rate', pricing_model: 'hourly', value: 100 });
    expect(await orgQuote('res_main')).toMatchObject({ breakdown: { total_pence: 200, discount_pence: 0 } });
  });

  it('respects effective dates and disabled arrangements', async () => {
    const r = await add({ resource_id: 'res_main', arrangement_type: 'free', effective_from: '2027-06-01T00:00:00Z' });
    expect(await orgQuote('res_main')).toMatchObject({ breakdown: { total_pence: 2000 } });
    await call(arrangement.onRequestPut, {
      env, cookie: admin, method: 'PUT', params: { id: r.body.id },
      body: { organisation_id: 'org1', resource_id: 'res_main', arrangement_type: 'free', effective_from: '2027-01-01T00:00:00Z', is_active: false },
    });
    expect(await orgQuote('res_main')).toMatchObject({ breakdown: { total_pence: 2000 } });
  });

  it('refuses a second arrangement for the same resource and period', async () => {
    expect((await add({ resource_id: 'res_main', arrangement_type: 'free' })).status).toBe(201);
    expect((await add({ resource_id: 'res_main', arrangement_type: 'rate', pricing_model: 'hourly', value: 1 })).status).toBe(409);
    // A non-overlapping period is fine.
    const r = await call(arrangements.onRequestPost, { env, cookie: admin, body: { organisation_id: 'org1', resource_id: 'res_kitchen', arrangement_type: 'free', effective_from: '2027-01-01T00:00:00Z', effective_to: '2027-02-01T00:00:00Z' } });
    expect(r.status).toBe(201);
    expect((await add({ resource_id: 'res_kitchen', arrangement_type: 'free', effective_from: '2027-02-01T00:00:00Z' })).status).toBe(201);
    // A rate or free use must name a resource.
    expect((await add({ arrangement_type: 'free' })).status).toBe(400);
  });

  it('records the arrangement on the booking and keeps the price when it changes', async () => {
    const created = await add({ resource_id: 'res_main', arrangement_type: 'percentage', value: 5000 });
    const b = await createBookingAtomic({ env, userId: 'u1', resourceId: 'res_main', ...win, actorId: 'u1', organisationId: 'org1' });
    expect(b).toMatchObject({ ok: true, totalPence: 1000 });
    await call(arrangement.onRequestDelete, { env, cookie: admin, method: 'DELETE', params: { id: created.body.id } });
    const row = await db.prepare('SELECT total_amount_pence, organisation_pricing_id FROM bookings').first();
    expect(row).toEqual({ total_amount_pence: 1000, organisation_pricing_id: created.body.id });
  });

  it('is shown to the customer in the quote before booking', async () => {
    await add({ resource_id: 'res_main', arrangement_type: 'percentage', value: 2500 });
    const cookie = await sessionFor(env, 'u1');
    const res = await call(quote.onRequestPost, { env, cookie, body: { resource_id: 'res_main', starts_at: win.startsAt, ends_at: win.endsAt, organisation_id: 'org1' } });
    expect(res.body).toMatchObject({ total_pence: 1500, discount_label: 'Organisation discount (25%)' });
  });

  it('requires pricing permission to manage arrangements', async () => {
    await addAdmin(db, 'booker', 'booking_admin');
    const cookie = await sessionFor(env, 'booker');
    expect((await call(arrangements.onRequestPost, { env, cookie, body: { organisation_id: 'org1', arrangement_type: 'percentage', value: 1, effective_from: '2027-01-01T00:00:00Z' } })).status).toBe(403);
  });
});
