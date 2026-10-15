import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import { loadAccess } from '../functions/_lib/auth';
import { setAdminRole } from '../functions/_lib/admins';
import * as adminBookings from '../functions/api/admin/bookings';
import * as approve from '../functions/api/admin/bookings/[id]';
import * as pricing from '../functions/api/admin/pricing/rates/index';
import * as admins from '../functions/api/admin/admins';
import * as adminRole from '../functions/api/admin/admins/[id]';
import * as settings from '../functions/api/admin/settings';
import * as closures from '../functions/api/admin/closures';

let env: Env;
let db: D1Database;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ env, db, dispose } = await createTestEnv());
  await addAdmin(db, 'super', 'super_admin');
  await addAdmin(db, 'booker', 'booking_admin');
  await addAdmin(db, 'viewer', 'viewer');
  await addUser(db, 'customer');
});

afterEach(async () => {
  await dispose();
});

describe('role permissions (FR08)', () => {
  it('maps each role to the permission matrix', async () => {
    const superAccess = await loadAccess(env, 'super');
    expect(superAccess.permissions).toHaveLength(12);
    const booker = await loadAccess(env, 'booker');
    expect(booker.roles).toEqual(['booking_admin']);
    expect(booker.permissions).toEqual(
      ['assets.manage', 'availability.manage', 'bookings.approve', 'bookings.create', 'bookings.manage', 'bookings.view', 'finance.view', 'resources.manage'],
    );
    expect((await loadAccess(env, 'viewer')).permissions).toEqual(['bookings.view', 'finance.view']);
    expect((await loadAccess(env, 'customer')).permissions).toEqual([]);
  });

  it('migrates Release 1 administrators to Booking Admin without changing their role rows', async () => {
    // The Release 1 'admin' role keeps its id, so existing user_roles rows still resolve.
    const row = await db.prepare("SELECT name FROM roles WHERE id = 'role_admin'").first<{ name: string }>();
    expect(row?.name).toBe('booking_admin');
    const rows = await db.prepare("SELECT COUNT(*) AS c FROM user_roles WHERE user_id = 'booker' AND role_id = 'role_admin'").first<{ c: number }>();
    expect(rows?.c).toBe(1);
  });

  it('gives Viewers read-only access', async () => {
    const cookie = await sessionFor(env, 'viewer');
    expect((await call(adminBookings.onRequestGet, { env, cookie })).status).toBe(200);
    expect((await call(approve.onRequestPost, { env, cookie, params: { id: 'x' }, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(closures.onRequestPost, { env, cookie, body: {} })).status).toBe(403);
    expect((await call(pricing.onRequestPost, { env, cookie, body: {} })).status).toBe(403);
  });

  it('lets Booking Admins run bookings but not pricing, administrators or settings', async () => {
    const cookie = await sessionFor(env, 'booker');
    expect((await call(adminBookings.onRequestGet, { env, cookie })).status).toBe(200);
    expect((await call(pricing.onRequestPost, { env, cookie, body: { resource_id: 'res_main', pricing_model: 'hourly', amount_pence: 1, effective_from: '2026-01-01T00:00:00Z' } })).status).toBe(403);
    expect((await call(admins.onRequestGet, { env, cookie })).status).toBe(403);
    expect((await call(adminRole.onRequestPut, { env, cookie, method: 'PUT', params: { id: 'customer' }, body: { role: 'super_admin' } })).status).toBe(403);
    expect((await call(settings.onRequestGet, { env, cookie })).status).toBe(403);
  });

  it('rejects customers and anonymous requests', async () => {
    const cookie = await sessionFor(env, 'customer');
    expect((await call(adminBookings.onRequestGet, { env, cookie })).status).toBe(403);
    expect((await call(adminBookings.onRequestGet, { env })).status).toBe(401);
  });
});

describe('administrator management (FR08)', () => {
  it('lets Super Admins assign, change and revoke roles', async () => {
    const cookie = await sessionFor(env, 'super');
    const put = (id: string, role: string | null) => call(adminRole.onRequestPut, { env, cookie, method: 'PUT', params: { id }, body: { role } });
    expect((await put('customer', 'viewer')).status).toBe(200);
    expect((await loadAccess(env, 'customer')).roles).toEqual(['viewer']);
    expect((await put('customer', 'booking_admin')).status).toBe(200);
    expect((await loadAccess(env, 'customer')).roles).toEqual(['booking_admin']);
    expect((await put('customer', null)).status).toBe(200);
    expect((await loadAccess(env, 'customer')).roles).toEqual([]);
    const listed = await call(admins.onRequestGet, { env, cookie });
    expect(listed.body.map((a: { id: string }) => a.id).sort()).toEqual(['booker', 'super', 'viewer']);
    const events = await db.prepare("SELECT COUNT(*) AS c FROM admin_role_events WHERE user_id = 'customer'").first<{ c: number }>();
    expect(events?.c).toBe(3);
  });

  it('never removes the last Super Admin', async () => {
    const cookie = await sessionFor(env, 'super');
    const res = await call(adminRole.onRequestPut, { env, cookie, method: 'PUT', params: { id: 'super' }, body: { role: 'viewer' } });
    expect(res.status).toBe(409);
    expect((await loadAccess(env, 'super')).roles).toEqual(['super_admin']);
  });

  it('allows only one of two simultaneous demotions of the last two Super Admins', async () => {
    await setAdminRole(env, { userId: 'booker', role: 'super_admin', actorId: 'super' });
    const results = await Promise.all([
      setAdminRole(env, { userId: 'super', role: null, actorId: 'booker' }),
      setAdminRole(env, { userId: 'booker', role: 'viewer', actorId: 'super' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const count = await db.prepare("SELECT COUNT(*) AS c FROM user_roles WHERE role_id = 'role_super_admin'").first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it('validates settings updates', async () => {
    const cookie = await sessionFor(env, 'super');
    expect((await call(settings.onRequestPut, { env, cookie, method: 'PUT', body: { values: { contact_email: 'not-an-email' } } })).status).toBe(400);
    expect((await call(settings.onRequestPut, { env, cookie, method: 'PUT', body: { values: { unknown: 'x' } } })).status).toBe(400);
    expect((await call(settings.onRequestPut, { env, cookie, method: 'PUT', body: { values: { venue_name: '1st Stratton Scouts' } } })).status).toBe(200);
    const res = await call(settings.onRequestGet, { env, cookie });
    expect(res.body.find((s: { key: string }) => s.key === 'venue_name').value).toBe('1st Stratton Scouts');
    // The email logo is optional but must be an https address.
    expect((await call(settings.onRequestPut, { env, cookie, method: 'PUT', body: { values: { email_logo_url: 'http://x.example/logo.png' } } })).status).toBe(400);
    expect((await call(settings.onRequestPut, { env, cookie, method: 'PUT', body: { values: { email_logo_url: '' } } })).status).toBe(200);
    expect((await call(settings.onRequestPut, { env, cookie, method: 'PUT', body: { values: { email_logo_url: 'https://cdn.example/logo.png' } } })).status).toBe(200);
  });
});
