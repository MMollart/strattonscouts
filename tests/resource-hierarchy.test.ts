import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { createBookingAtomic } from '../functions/_lib/booking';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as bookingsApi from '../functions/api/bookings/index';
import * as availabilityApi from '../functions/api/availability';
import * as resourcesApi from '../functions/api/resources/index';
import * as adminResourcesApi from '../functions/api/admin/resources';
import * as adminResourceApi from '../functions/api/admin/resources/[id]';
import { ancestorIds, blockedMessage, hierarchyRelation, isWithin, parentOptions, wouldCreateLoop } from '@shared/hierarchy';

/**
 * The resource hierarchy from the feature request:
 *
 *   Whole Venue
 *     Indoor: Main Hall, Small Hall, Kitchen
 *     Outdoor: Event Field, Camping
 *
 * built through the admin API on top of the seed data.
 */

let env: Env;
let db: D1Database;
let dispose: () => Promise<void>;
let admin: string;

const day = () => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
const at = (from: string, to: string) => ({ startsAt: `${day()}T${from}:00.000Z`, endsAt: `${day()}T${to}:00.000Z` });
const slot = at('10:00', '12:00');

function book(resourceId: string, window = slot, userId = 'u1') {
  return createBookingAtomic({ env, userId, resourceId, ...window, actorId: userId });
}

async function setParent(id: string, parentId: string | null) {
  const current = await db.prepare('SELECT name, slug, description, is_active, requires_approval, pricing_model FROM resources WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return call(adminResourceApi.onRequestPut, {
    env,
    cookie: admin,
    method: 'PUT',
    params: { id },
    body: { ...current, is_active: !!current!.is_active, requires_approval: !!current!.requires_approval, parent_id: parentId },
  });
}

async function addGroup(name: string, slug: string): Promise<string> {
  const res = await call(adminResourcesApi.onRequestPost, {
    env,
    cookie: admin,
    body: { name, slug, description: '', pricing_model: 'hourly', parent_id: 'res_whole' },
  });
  expect(res.status).toBe(201);
  const ts = new Date().toISOString();
  await db
    .prepare("INSERT INTO base_rates (id, resource_id, pricing_model, amount_pence, effective_from, created_at, updated_at) VALUES (?, ?, 'hourly', 2000, '1970-01-01T00:00:00.000Z', ?, ?)")
    .bind(`p_${slug}`, res.body.id, ts, ts)
    .run();
  return res.body.id;
}

let indoor: string;
let outdoor: string;

beforeEach(async () => {
  ({ env, db, dispose } = await createTestEnv());
  await addUser(db, 'u1');
  await addUser(db, 'u2');
  await addAdmin(db, 'admin', 'super_admin');
  admin = await sessionFor(env, 'admin');
  indoor = await addGroup('Indoor', 'indoor');
  outdoor = await addGroup('Outdoor', 'outdoor');
  for (const id of ['res_main', 'res_small', 'res_kitchen']) expect((await setParent(id, indoor)).status).toBe(200);
  for (const id of ['res_field', 'res_camping']) expect((await setParent(id, outdoor)).status).toBe(200);
});

afterEach(async () => {
  await dispose();
});

describe('booking with a resource hierarchy', () => {
  it('booking the Whole Venue blocks every resource beneath it', async () => {
    expect((await book('res_whole')).ok).toBe(true);
    for (const id of [indoor, outdoor, 'res_main', 'res_small', 'res_kitchen', 'res_field', 'res_camping']) {
      expect(await book(id, slot, 'u2')).toMatchObject({ ok: false, code: 'conflict' });
    }
  });

  it('booking Indoor blocks the halls and kitchen but leaves Outdoor free', async () => {
    expect((await book(indoor)).ok).toBe(true);
    for (const id of ['res_main', 'res_small', 'res_kitchen', 'res_whole']) {
      expect(await book(id, slot, 'u2')).toMatchObject({ ok: false, code: 'conflict' });
    }
    expect((await book(outdoor, slot, 'u2')).ok).toBe(true);
  });

  it('booking the Main Hall blocks Indoor and the Whole Venue, not its siblings', async () => {
    expect((await book('res_main')).ok).toBe(true);
    expect(await book(indoor, slot, 'u2')).toMatchObject({ ok: false, code: 'conflict' });
    expect(await book('res_whole', slot, 'u2')).toMatchObject({ ok: false, code: 'conflict' });
    expect((await book('res_small', slot, 'u2')).ok).toBe(true);
    expect((await book('res_kitchen', slot, 'u2')).ok).toBe(true);
    expect((await book(outdoor, slot, 'u2')).ok).toBe(true);
  });

  it('applies the same rule to the same customer', async () => {
    expect((await book('res_main')).ok).toBe(true);
    expect(await book(indoor)).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('only blocks overlapping periods', async () => {
    expect((await book('res_whole')).ok).toBe(true);
    expect((await book('res_main', at('12:00', '14:00'))).ok).toBe(true);
    expect((await book(indoor, at('08:00', '10:00'))).ok).toBe(true);
  });

  it('refuses a parent and any descendant in the same booking', async () => {
    const cookie = await sessionFor(env, 'u1');
    const w = { starts_at: slot.startsAt, ends_at: slot.endsAt };
    const res = await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_kitchen', additional_resource_ids: ['res_whole'], ...w } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Kitchen is part of Whole Venue, so they cannot be booked together. Whole Venue already includes it.');
    // Siblings and unrelated groups are fine together.
    const ok = await call(bookingsApi.onRequestPost, { env, cookie, body: { resource_id: 'res_main', additional_resource_ids: ['res_small', outdoor], ...w } });
    expect(ok.status).toBe(201);
  });

  it('closing a group closes everything in it and the venue above it', async () => {
    await db
      .prepare('INSERT INTO resource_closures (id, resource_id, starts_at, ends_at, reason, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
      .bind('cl1', indoor, slot.startsAt, slot.endsAt, new Date().toISOString())
      .run();
    expect(await book('res_main')).toMatchObject({ ok: false, code: 'closure' });
    expect(await book('res_whole')).toMatchObject({ ok: false, code: 'closure' });
    expect((await book('res_field')).ok).toBe(true);
  });

  it('says which parent or child makes a resource unavailable', async () => {
    expect((await book('res_main')).ok).toBe(true);
    const q = `starts_at=${slot.startsAt}&ends_at=${slot.endsAt}`;
    const whole = await call(availabilityApi.onRequestGet, { env, path: `/api/availability?resource_id=res_whole&${q}` });
    expect(whole.body).toEqual({ available: false, reason: 'conflict', blocked_by: { name: 'Main Hall', relation: 'child' } });
    expect((await book(outdoor, at('13:00', '14:00'))).ok).toBe(true);
    const field = await call(availabilityApi.onRequestGet, { env, path: `/api/availability?resource_id=res_field&starts_at=${day()}T13:00:00.000Z&ends_at=${day()}T14:00:00.000Z` });
    expect(field.body.blocked_by).toEqual({ name: 'Outdoor', relation: 'parent' });
    const small = await call(availabilityApi.onRequestGet, { env, path: `/api/availability?resource_id=res_small&${q}` });
    expect(small.body.available).toBe(true);
  });

  it('lists every resource with its ancestors for the booking page', async () => {
    const res = await call(resourcesApi.onRequestGet, { env });
    const main = res.body.find((r: { id: string }) => r.id === 'res_main');
    expect(main).toMatchObject({ parent_id: indoor, ancestor_ids: [indoor, 'res_whole'] });
  });
});

describe('resource parent settings', () => {
  it('refuses a resource as its own parent or below itself', async () => {
    expect((await setParent('res_whole', 'res_whole')).status).toBe(400);
    const loop = await setParent('res_whole', 'res_main');
    expect(loop.status).toBe(400);
    expect(loop.body.error).toBe('Main Hall is already part of this resource, so it cannot also be its parent.');
    expect((await setParent(indoor, 'res_kitchen')).status).toBe(400);
    expect((await db.prepare('SELECT parent_id FROM resources WHERE id = ?').bind('res_whole').first())?.parent_id).toBeNull();
  });

  it('refuses a parent that does not exist', async () => {
    expect((await setParent('res_main', 'res_nope')).status).toBe(400);
  });

  it('refuses a move that would turn existing bookings into a double booking', async () => {
    expect((await book('res_main')).ok).toBe(true);
    expect((await book('res_field', slot, 'u2')).ok).toBe(true);
    const res = await setParent('res_main', 'res_field');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Main Hall \(.+\) and Event Field \(.+\) are booked at overlapping times/);
    // Moving it to the top level is always safe.
    expect((await setParent('res_main', null)).status).toBe(200);
  });
});

describe('migrating the conflict matrix', () => {
  it('turns the live conflicts into a hierarchy', async () => {
    const m = await createTestEnv({ stopBefore: '0015' });
    try {
      const ts = '2026-01-01T00:00:00Z';
      const edge = (a: string, b: string, mandatory = 0) =>
        m.db.prepare('INSERT OR IGNORE INTO resource_conflicts (id, resource_id, conflicts_with_id, is_mandatory, created_at) VALUES (?, ?, ?, ?, ?)').bind(`${a}-${b}`, a, b, mandatory, ts);
      // Production on 2026-10-15: Building conflicts with the halls and kitchen; Whole Venue is combined.
      await m.db.batch([
        m.db.prepare("INSERT INTO resources (id, name, slug, description, resource_type, is_active, requires_approval, pricing_model, created_at, updated_at) VALUES ('res_building', 'Building', 'building', '', 'individual', 1, 0, 'hourly', ?, ?)").bind(ts, ts),
        m.db.prepare("INSERT INTO resources (id, name, slug, description, resource_type, is_active, requires_approval, pricing_model, created_at, updated_at) VALUES ('res_hammock', 'Hammock Star', 'hammock-star', '', 'individual', 1, 0, 'hourly', ?, ?)").bind(ts, ts),
        ...['res_building', 'res_hammock'].flatMap((id) => [edge(id, id, 1), edge(id, 'res_whole', 1), edge('res_whole', id, 1)]),
        ...['res_main', 'res_small', 'res_kitchen'].flatMap((id) => [edge('res_building', id), edge(id, 'res_building')]),
      ]);
      await m.applyRemaining();
      const rows = await m.db.prepare('SELECT id, parent_id FROM resources ORDER BY id').all<{ id: string; parent_id: string | null }>();
      expect(Object.fromEntries(rows.results.map((r) => [r.id, r.parent_id]))).toEqual({
        res_building: 'res_whole',
        res_camping: 'res_whole',
        res_field: 'res_whole',
        res_hammock: 'res_whole',
        res_kitchen: 'res_building',
        res_main: 'res_building',
        res_small: 'res_building',
        res_whole: null,
      });
    } finally {
      await m.dispose();
    }
  });
});

describe('hierarchy helpers', () => {
  const nodes = [
    { id: 'whole', parent_id: null },
    { id: 'indoor', parent_id: 'whole' },
    { id: 'main', parent_id: 'indoor' },
    { id: 'small', parent_id: 'indoor' },
  ];
  const ancestorsOf = (id: string) => ancestorIds(id, nodes);

  it('lists ancestors nearest first and survives a loop', () => {
    expect(ancestorIds('main', nodes)).toEqual(['indoor', 'whole']);
    expect(ancestorIds('a', [{ id: 'a', parent_id: 'b' }, { id: 'b', parent_id: 'a' }])).toEqual(['b']);
  });

  it('relates parents and children but not siblings', () => {
    expect(hierarchyRelation('main', 'whole', ancestorsOf)).toBe('parent');
    expect(hierarchyRelation('whole', 'main', ancestorsOf)).toBe('child');
    expect(hierarchyRelation('main', 'small', ancestorsOf)).toBeNull();
  });

  it('spots loops before they are saved', () => {
    expect(wouldCreateLoop('whole', 'main', nodes)).toBe(true);
    expect(wouldCreateLoop('main', 'main', nodes)).toBe(true);
    expect(wouldCreateLoop('small', 'main', nodes)).toBe(false);
  });

  it('offers each group with something beneath it as a filter, in tree order', () => {
    const withField = [...nodes, { id: 'outdoor', parent_id: 'whole' }, { id: 'field', parent_id: 'outdoor' }];
    expect(parentOptions(withField).map((o) => [o.node.id, o.depth])).toEqual([['whole', 0], ['indoor', 1], ['outdoor', 1]]);
  });

  it('filters a group to itself and everything beneath it', () => {
    expect(nodes.filter((n) => isWithin(n.id, 'indoor', ancestorsOf)).map((n) => n.id)).toEqual(['indoor', 'main', 'small']);
    expect(nodes.filter((n) => isWithin(n.id, 'whole', ancestorsOf))).toHaveLength(4);
  });

  it('explains the cause', () => {
    expect(blockedMessage('booked', { name: 'Whole Venue', relation: 'parent' })).toBe('Whole Venue is booked at this time, and it includes this resource.');
    expect(blockedMessage('closed', { name: 'Main Hall', relation: 'child' })).toBe('Main Hall is closed at this time, and it is part of this resource.');
  });
});
