import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as bookingsApi from '../functions/api/bookings/index';
import * as bookingApi from '../functions/api/bookings/[id]';

describe('several resources in one booking', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;
  let cookie: string;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addUser(db, 'u2');
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

  it('books each resource with its own price and approval, linked as one group', async () => {
    const w = slot();
    const res = await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', additional_resource_ids: ['res_kitchen', 'res_field'], ...w } });
    expect(res.status).toBe(201);
    expect(res.body.bookings).toHaveLength(3);
    const byResource = Object.fromEntries(res.body.bookings.map((b: { resource_id: string }) => [b.resource_id, b]));
    // Scouts prices: main hall 1000/h, kitchen 300/h; the field needs approval.
    expect(byResource.res_main).toMatchObject({ status: 'confirmed', total_amount_pence: 2000 });
    expect(byResource.res_kitchen).toMatchObject({ status: 'confirmed', total_amount_pence: 600 });
    expect(byResource.res_field.status).toBe('pending_approval');
    expect(res.body.total_amount_pence).toBe(res.body.bookings.reduce((s: number, b: { total_amount_pence: number }) => s + b.total_amount_pence, 0));

    const rows = await db.prepare('SELECT DISTINCT group_id FROM bookings').all<{ group_id: string }>();
    expect(rows.results).toEqual([{ group_id: res.body.group_id }]);

    // One email per outcome, naming every resource it covers.
    const emails = await db.prepare('SELECT template, subject FROM email_events ORDER BY template').all<{ template: string }>();
    expect(emails.results.map((e) => e.template)).toEqual(['booking_confirmation', 'booking_request_received']);

    const detail = await call(bookingApi.onRequestGet, { env, cookie, params: { id: byResource.res_kitchen.id } });
    expect(detail.body.group.map((g: { resource_name: string }) => g.resource_name)).toEqual(['Event Field', 'Kitchen', 'Main Hall']);
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

  it('keeps single-resource bookings unchanged', async () => {
    const res = await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', additional_resource_ids: ['res_main'], ...slot() } });
    expect(res.status).toBe(201);
    expect(res.body.group_id).toBeUndefined();
    expect(await db.prepare('SELECT group_id FROM bookings').first()).toEqual({ group_id: null });
  });
});
