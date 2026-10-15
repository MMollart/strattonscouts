import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as typesApi from '../functions/api/admin/asset-types/index';
import * as typeApi from '../functions/api/admin/asset-types/[id]';
import * as assetsApi from '../functions/api/admin/assets/index';
import * as assetApi from '../functions/api/admin/assets/[id]';
import * as assignApi from '../functions/api/admin/assets/[id]/assign';
import * as returnApi from '../functions/api/admin/assets/[id]/return';
import * as myAssetsApi from '../functions/api/assets';

describe('physical asset management (FR07)', () => {
  let env: Env;
  let db: D1Database;
  let dispose: () => Promise<void>;
  let admin: string;

  beforeEach(async () => {
    ({ env, db, dispose } = await createTestEnv());
    await addUser(db, 'u1');
    await addUser(db, 'u2');
    await addAdmin(db, 'booker', 'booking_admin');
    await addAdmin(db, 'viewer', 'viewer');
    admin = await sessionFor(env, 'booker');
  });
  afterEach(async () => {
    await dispose();
  });

  const register = async (body: Record<string, unknown> = {}) =>
    call(assetsApi.onRequestPost, { env, cookie: admin, body: { asset_type_id: 'atype_fob', name: 'Front door fob', reference: 'FOB-001', ...body } });
  const assign = (id: string, user_id: string, cookie = admin) => call(assignApi.onRequestPost, { env, cookie, params: { id }, body: { user_id, notes: 'For Tuesday Cubs' } });
  const giveBack = (id: string, body: Record<string, unknown> = {}) => call(returnApi.onRequestPost, { env, cookie: admin, params: { id }, body });

  it('lets administrators configure asset types', async () => {
    const list = await call(typesApi.onRequestGet, { env, cookie: admin });
    expect(list.body.map((t: { name: string }) => t.name)).toEqual(['Key fob', 'Physical key', 'Access card', 'Loaned equipment']);
    const created = await call(typesApi.onRequestPost, { env, cookie: admin, body: { name: 'Projector', sort_order: 5 } });
    expect(created.status).toBe(201);
    expect((await call(typesApi.onRequestPost, { env, cookie: admin, body: { name: 'projector' } })).status).toBe(409);
    expect((await call(typeApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: created.body.id }, body: { name: 'Projector', is_active: false } })).status).toBe(200);
    // Retired types cannot be used for new assets.
    expect((await register({ asset_type_id: created.body.id, reference: null })).status).toBe(400);
  });

  it('registers assets with unique references and respects permissions', async () => {
    const viewer = await sessionFor(env, 'viewer');
    expect((await call(assetsApi.onRequestGet, { env, cookie: viewer })).status).toBe(403);
    expect((await call(assetsApi.onRequestPost, { env, cookie: viewer, body: { asset_type_id: 'atype_fob', name: 'x' } })).status).toBe(403);
    expect((await call(myAssetsApi.onRequestGet, { env })).status).toBe(401);

    const a = await register();
    expect(a.status).toBe(201);
    expect((await register({ reference: 'fob-001' })).status).toBe(409);
    expect((await register({ name: 'Spare', reference: '' })).status).toBe(201);
    expect((await register({ name: 'Spare 2', reference: null })).status).toBe(201);
    const list = await call(assetsApi.onRequestGet, { env, cookie: admin, path: '/api/admin/assets?q=FOB-0' });
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: 'Front door fob', status: 'available', asset_type_name: 'Key fob', assigned_user_id: null });
  });

  it('assigns to one user at a time, returns, and keeps the history', async () => {
    const { body: { id } } = await register();
    expect((await assign(id, 'nobody')).status).toBe(400);
    expect((await assign(id, 'u1')).status).toBe(201);

    // No duplicate active assignment, even when two admins act at once.
    expect((await assign(id, 'u2')).status).toBe(409);
    const { body: { id: id2 } } = await register({ name: 'Hall key', reference: 'KEY-1', asset_type_id: 'atype_key' });
    const race = await Promise.all([assign(id2, 'u1'), assign(id2, 'u2')]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await db.prepare('SELECT COUNT(*) AS c FROM asset_assignments WHERE asset_id = ? AND returned_at IS NULL').bind(id2).first<{ c: number }>())?.c).toBe(1);

    // An assigned asset's status changes only through a return.
    const edit = { asset_type_id: 'atype_fob', name: 'Front door fob', reference: 'FOB-001' };
    expect((await call(assetApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id }, body: { ...edit, status: 'retired' } })).status).toBe(409);
    expect((await call(assetApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id }, body: { ...edit, name: 'Main door fob' } })).body.status).toBe('assigned');

    const mine = await call(myAssetsApi.onRequestGet, { env, cookie: await sessionFor(env, 'u1') });
    expect(mine.body.map((a: { name: string }) => a.name)).toContain('Main door fob');
    const outstanding = await call(assetsApi.onRequestGet, { env, cookie: admin, path: '/api/admin/assets?status=assigned' });
    expect(outstanding.body).toHaveLength(2);

    expect((await giveBack(id, { notes: 'All fine' })).body).toMatchObject({ ok: true, status: 'available' });
    expect((await giveBack(id)).status).toBe(409);
    expect((await assign(id, 'u2')).status).toBe(201);
    expect((await giveBack(id, { outcome: 'damaged', notes: 'Cracked case' })).body.status).toBe('damaged');
    // Damaged assets can still be lent; lost ones cannot.
    expect((await assign(id, 'u1')).status).toBe(201);
    expect((await giveBack(id, { outcome: 'lost' })).body.status).toBe('lost');
    const lost = await assign(id, 'u2');
    expect(lost.status).toBe(409);
    expect(lost.body.error).toMatch(/lost asset cannot be assigned/);

    const detail = await call(assetApi.onRequestGet, { env, cookie: admin, params: { id } });
    expect(detail.body.status).toBe('lost');
    expect(detail.body.history).toHaveLength(3);
    expect(detail.body.history[2]).toMatchObject({
      user_id: 'u1', assigned_by: 'booker', assign_notes: 'For Tuesday Cubs', returned_by: 'booker', return_notes: 'All fine', outcome: 'available',
    });
    expect(detail.body.history[2].assigned_at).toBeTruthy();
    expect(detail.body.history[2].returned_at).toBeTruthy();
    expect(detail.body.history[0]).toMatchObject({ outcome: 'lost' });
  });

  it('does not lend retired assets', async () => {
    const { body: { id } } = await register();
    await call(assetApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id }, body: { asset_type_id: 'atype_fob', name: 'Old fob', reference: 'FOB-001', status: 'retired' } });
    const res = await assign(id, 'u1');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/retired/);
    // A found lost asset can be marked available again by editing it.
    await call(assetApi.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id }, body: { asset_type_id: 'atype_fob', name: 'Old fob', reference: 'FOB-001', status: 'available' } });
    expect((await assign(id, 'u1')).status).toBe(201);
  });
});
