import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computePrice, discountAmount, type RateRule } from '@shared/pricing';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import { createBookingAtomic } from '../functions/_lib/booking';
import { quotePrice } from '../functions/_lib/pricing-engine';
import * as quote from '../functions/api/pricing/quote';
import * as rates from '../functions/api/admin/pricing/rates/index';
import * as discounts from '../functions/api/admin/pricing/discounts/index';
import * as categories from '../functions/api/admin/categories/index';
import * as publicResource from '../functions/api/resources/[slug]';

const day = { startsAt: '2027-03-06T10:00:00.000Z', endsAt: '2027-03-06T12:30:00.000Z' }; // 2.5h -> 3 billable hours
const rate = (model: RateRule['pricing_model'], amount: number): RateRule => ({ id: 'r', pricing_model: model, amount_pence: amount });

describe('computePrice (FR02)', () => {
  it('supports hourly, per-night, fixed and free models', () => {
    expect(computePrice({ categoryRate: rate('hourly', 1000), generalDiscounts: [], arrangement: null, ...day })).toMatchObject({ quantity: 3, quantity_unit: 'hour', total_pence: 3000 });
    expect(computePrice({ categoryRate: rate('nightly', 2000), generalDiscounts: [], arrangement: null, startsAt: '2027-03-05T17:00:00Z', endsAt: '2027-03-07T10:00:00Z' })).toMatchObject({ quantity: 2, quantity_unit: 'night', total_pence: 4000 });
    expect(computePrice({ categoryRate: rate('fixed', 5000), generalDiscounts: [], arrangement: null, ...day })).toMatchObject({ quantity: 1, total_pence: 5000 });
    expect(computePrice({ categoryRate: rate('free', 999), generalDiscounts: [], arrangement: null, ...day })).toMatchObject({ unit_price_pence: 0, total_pence: 0 });
    expect(computePrice({ categoryRate: null, generalDiscounts: [], arrangement: null, ...day })).toBeNull();
  });

  it('applies percentage and fixed discounts in integer pence, never below zero', () => {
    expect(discountAmount(3333, { id: 'd', label: 'x', discount_type: 'percentage', value: 1000 })).toBe(333);
    expect(discountAmount(3335, { id: 'd', label: 'x', discount_type: 'percentage', value: 1000 })).toBe(334);
    expect(discountAmount(500, { id: 'd', label: 'x', discount_type: 'fixed', value: 800 })).toBe(500);
    const p = computePrice({
      categoryRate: rate('hourly', 1000),
      generalDiscounts: [
        { id: 'a', label: '10% off', discount_type: 'percentage', value: 1000 },
        { id: 'b', label: '£5 off', discount_type: 'fixed', value: 500 },
      ],
      arrangement: null,
      ...day,
    });
    // The single best discount applies: £5 beats 10% of £30.
    expect(p).toMatchObject({ base_amount_pence: 3000, discount_pence: 500, discount_label: '£5 off', total_pence: 2500, pricing_discount_id: 'b' });
  });

  it('applies organisation arrangements by precedence without stacking', () => {
    const general = [{ id: 'g', label: 'Big', discount_type: 'percentage' as const, value: 9000 }];
    const r = computePrice({ categoryRate: rate('hourly', 1000), generalDiscounts: general, arrangement: { id: 'o1', kind: 'rate', label: 'Agreed', rate: rate('hourly', 400) }, ...day });
    expect(r).toMatchObject({ total_pence: 1200, discount_pence: 0, source: 'organisation_rate', organisation_pricing_id: 'o1' });
    const free = computePrice({ categoryRate: rate('hourly', 1000), generalDiscounts: general, arrangement: { id: 'o2', kind: 'free', label: 'Free use' }, ...day });
    expect(free).toMatchObject({ total_pence: 0, source: 'organisation_free' });
    const disc = computePrice({ categoryRate: rate('hourly', 1000), generalDiscounts: general, arrangement: { id: 'o3', kind: 'discount', label: '20%', discount: { id: 'o3', label: '20%', discount_type: 'percentage', value: 2000 } }, ...day });
    expect(disc).toMatchObject({ base_amount_pence: 3000, discount_pence: 600, total_pence: 2400, source: 'organisation_discount' });
  });
});

describe('pricing engine against D1 (FR02)', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addAdmin(db, 'super', 'super_admin');
  });
  afterEach(async () => {
    await dispose();
  });

  it('migrates Release 1 prices into rates unchanged', async () => {
    const q = await quotePrice(env, { resourceId: 'res_main', userId: 'u1', ...day });
    expect(q).toMatchObject({ ok: true, breakdown: { pricing_model: 'hourly', unit_price_pence: 1000, total_pence: 3000 } });
    const res = await call(publicResource.onRequestGet, { env, params: { slug: 'main-hall' } });
    expect(res.body.prices[0]).toMatchObject({ category: 'scouts', pricing_model: 'hourly', amount_pence: 1000, is_free: false });
  });

  it('uses the rate effective at the booking start', async () => {
    const cookie = await sessionFor(env, 'super');
    const add = await call(rates.onRequestPost, {
      env, cookie,
      body: { resource_id: 'res_main', pricing_model: 'fixed', amount_pence: 7000, effective_from: '2027-03-01T00:00:00Z', effective_to: '2027-04-01T00:00:00Z' },
    });
    expect(add.status).toBe(201);
    expect((await quotePrice(env, { resourceId: 'res_main', userId: 'u1', ...day }))).toMatchObject({ breakdown: { pricing_model: 'fixed', total_pence: 7000 } });
    // Outside the range the original rate applies.
    expect((await quotePrice(env, { resourceId: 'res_main', userId: 'u1', startsAt: '2027-04-02T10:00:00Z', endsAt: '2027-04-02T11:00:00Z' }))).toMatchObject({ breakdown: { pricing_model: 'hourly', total_pence: 1000 } });
  });

  it('applies discounts scoped by resource and category and records the snapshot', async () => {
    const cookie = await sessionFor(env, 'super');
    await call(discounts.onRequestPost, {
      env, cookie,
      body: { name: 'Spring offer', discount_type: 'percentage', value: 2500, resource_id: 'res_main', category_id: 'cat_scouts', effective_from: '2027-01-01T00:00:00Z' },
    });
    await call(discounts.onRequestPost, {
      env, cookie,
      body: { name: 'Public only', discount_type: 'fixed', value: 2000, category_id: 'cat_public', effective_from: '2027-01-01T00:00:00Z' },
    });
    const booking = await createBookingAtomic({ env, userId: 'u1', resourceId: 'res_main', ...day, actorId: 'u1' });
    expect(booking).toMatchObject({ ok: true, totalPence: 2250 });
    const row = await db.prepare('SELECT base_amount_pence, discount_pence, discount_label, total_amount_pence, pricing_rate_id, pricing_discount_id, price_breakdown FROM bookings').first<Record<string, unknown>>();
    expect(row).toMatchObject({ base_amount_pence: 3000, discount_pence: 750, discount_label: 'Spring offer', total_amount_pence: 2250, pricing_rate_id: 'rate_pr_main_s' });
    expect(JSON.parse(row!.price_breakdown as string)).toMatchObject({ quantity: 3, total_pence: 2250 });
  });

  it('never changes the agreed price of existing bookings', async () => {
    const b = await createBookingAtomic({ env, userId: 'u1', resourceId: 'res_main', ...day, actorId: 'u1' });
    const cookie = await sessionFor(env, 'super');
    await call(rates.onRequestPost, { env, cookie, body: { resource_id: 'res_main', pricing_model: 'hourly', amount_pence: 99999, effective_from: '2000-01-01T00:00:00Z' } });
    await call(discounts.onRequestPost, { env, cookie, body: { name: 'All', discount_type: 'percentage', value: 5000, effective_from: '2000-01-01T00:00:00Z' } });
    const row = await db.prepare('SELECT total_amount_pence FROM bookings WHERE id = ?').bind(b.ok && b.bookingId).first<{ total_amount_pence: number }>();
    expect(row?.total_amount_pence).toBe(3000);
  });

  it('backfills Release 1 bookings so their snapshot is complete', async () => {
    const row = await db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE base_amount_pence IS NULL").first<{ c: number }>();
    expect(row?.c).toBe(0);
  });

  it('quotes over the API, including the zero-cost rate', async () => {
    const cookie = await sessionFor(env, 'u1');
    const admin = await sessionFor(env, 'super');
    await call(rates.onRequestPost, { env, cookie: admin, body: { resource_id: 'res_kitchen', pricing_model: 'free', amount_pence: 500, effective_from: '2000-01-01T00:00:00Z' } });
    const res = await call(quote.onRequestPost, { env, cookie, body: { resource_id: 'res_kitchen', starts_at: day.startsAt, ends_at: day.endsAt } });
    expect(res.body).toMatchObject({ pricing_model: 'free', total_pence: 0, category_id: 'cat_scouts' });
    expect((await call(quote.onRequestPost, { env, body: { resource_id: 'res_kitchen', starts_at: day.startsAt, ends_at: day.endsAt } })).status).toBe(401);
  });

  it('lets administrators add categories, and only with pricing permission', async () => {
    await addAdmin(db, 'booker', 'booking_admin');
    const booker = await sessionFor(env, 'booker');
    expect((await call(categories.onRequestPost, { env, cookie: booker, body: { name: 'schools', label: 'Schools' } })).status).toBe(403);
    const cookie = await sessionFor(env, 'super');
    expect((await call(categories.onRequestPost, { env, cookie, body: { name: 'schools', label: 'Schools' } })).status).toBe(201);
    expect((await call(categories.onRequestPost, { env, cookie, body: { name: 'schools', label: 'Again' } })).status).toBe(409);
  });

  it('validates rates and discounts', async () => {
    const cookie = await sessionFor(env, 'super');
    expect((await call(discounts.onRequestPost, { env, cookie, body: { name: 'Too much', discount_type: 'percentage', value: 10001, effective_from: '2027-01-01T00:00:00Z' } })).status).toBe(400);
    expect((await call(rates.onRequestPost, { env, cookie, body: { resource_id: 'res_main', pricing_model: 'hourly', amount_pence: -1, effective_from: '2027-01-01T00:00:00Z' } })).status).toBe(400);
    expect((await call(rates.onRequestPost, { env, cookie, body: { resource_id: 'res_main', pricing_model: 'hourly', amount_pence: 1, effective_from: '2027-02-01T00:00:00Z', effective_to: '2027-01-01T00:00:00Z' } })).status).toBe(400);
  });
});
