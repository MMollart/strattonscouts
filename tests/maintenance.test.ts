import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as bookingsApi from '../functions/api/bookings/index';
import * as availabilityApi from '../functions/api/availability';
import * as closuresApi from '../functions/api/admin/closures';
import * as maintenanceApi from '../functions/api/admin/maintenance/index';
import * as maintenanceOne from '../functions/api/admin/maintenance/[id]';
import * as affectedApi from '../functions/api/admin/maintenance/[id]/affected/[bookingId]';
import * as notifyApi from '../functions/api/admin/maintenance/[id]/notify';
import * as typesApi from '../functions/api/admin/maintenance-types/index';
import * as faultsApi from '../functions/api/admin/faults/index';
import * as faultOne from '../functions/api/admin/faults/[id]';

let env: Env;
let db: D1Database;
let dispose: () => Promise<void>;
let admin: string;
let customer: string;

beforeEach(async () => {
  ({ env, db, dispose } = await createTestEnv());
  await addUser(db, 'u1');
  await addAdmin(db, 'booker', 'booking_admin');
  await addAdmin(db, 'viewer', 'viewer');
  admin = await sessionFor(env, 'booker');
  customer = await sessionFor(env, 'u1');
});
afterEach(async () => {
  await dispose();
});

const inDays = (days: number, from = 10, to = 12) => {
  const d = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  return { starts_at: `${d}T${String(from).padStart(2, '0')}:00:00.000Z`, ends_at: `${d}T${String(to).padStart(2, '0')}:00:00.000Z` };
};

const maintenance = (over: Record<string, unknown> = {}) => ({
  resource_id: 'res_main',
  maintenance_type_id: 'mtype_repair',
  title: 'Replace hall lights',
  ...inDays(10, 9, 17),
  ...over,
});

async function available(resourceId: string, window: { starts_at: string; ends_at: string }): Promise<boolean> {
  const qs = new URLSearchParams({ resource_id: resourceId, ...window });
  const res = await call(availabilityApi.onRequestGet, { env, path: `/api/availability?${qs}` });
  return res.body.available;
}

async function book(resourceId: string, window: { starts_at: string; ends_at: string }) {
  return call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: resourceId, ...window } });
}

async function auditActions(entityId: string): Promise<string[]> {
  const rows = await db.prepare('SELECT action FROM audit_events WHERE entity_id = ? ORDER BY seq').bind(entityId).all<{ action: string }>();
  return rows.results.map((r) => r.action);
}

describe('scheduling maintenance (FR22 §4.2–4.5)', () => {
  it('blocks the resource and the resources it is part of, and releases them when completed', async () => {
    const parent = await db.prepare('SELECT parent_id FROM resources WHERE id = ?').bind('res_main').first<{ parent_id: string | null }>();
    const created = await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance({ assigned_admin_id: 'booker', notes: 'Electrician booked' }) });
    expect(created.status).toBe(201);
    expect(created.body.reference).toMatch(/^MNT-[A-Z0-9]{6}$/);
    const id = created.body.id;

    const during = inDays(10, 11, 12);
    expect(await available('res_main', during)).toBe(false);
    if (parent?.parent_id) expect(await available(parent.parent_id, during)).toBe(false);
    expect(await available('res_main', inDays(11, 11, 12))).toBe(true);
    expect((await book('res_main', during)).status).toBe(400);

    const one = await call(maintenanceOne.onRequestGet, { env, cookie: admin, params: { id } });
    expect(one.body).toMatchObject({ status: 'planned', is_blocking: true, assigned_admin_name: expect.any(String), maintenance_type_label: 'Repair' });

    const done = await call(maintenanceOne.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id }, body: maintenance({ status: 'completed' }) });
    expect(done.status).toBe(200);
    expect(await available('res_main', during)).toBe(true);
    expect(await auditActions(id)).toEqual(['maintenance.created', 'maintenance.completed']);
  });

  it('blocks a part when the whole it belongs to is under maintenance', async () => {
    const child = await db.prepare("SELECT id FROM resources WHERE parent_id = 'res_whole' LIMIT 1").first<{ id: string }>();
    expect(child).toBeTruthy();
    expect((await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance({ resource_id: 'res_whole' }) })).status).toBe(201);
    expect(await available(child!.id, inDays(10, 11, 12))).toBe(false);
  });

  it('does not block availability when the record says it does not', async () => {
    expect((await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance({ blocks_availability: false, maintenance_type_id: 'mtype_inspection' }) })).status).toBe(201);
    expect(await available('res_main', inDays(10, 11, 12))).toBe(true);
  });

  it('filters the list by resource, type, status and date', async () => {
    await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance() });
    await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance({ resource_id: 'res_kitchen', maintenance_type_id: 'mtype_cleaning', ...inDays(30) }) });
    const list = async (qs: string) => (await call(maintenanceApi.onRequestGet, { env, cookie: admin, path: `/api/admin/maintenance?${qs}` })).body as { resource_id: string }[];
    expect((await list('')).length).toBe(2);
    expect((await list('resource_id=res_kitchen')).map((m) => m.resource_id)).toEqual(['res_kitchen']);
    expect((await list('type_id=mtype_repair')).map((m) => m.resource_id)).toEqual(['res_main']);
    expect((await list('status=completed')).length).toBe(0);
    const w = inDays(30);
    expect((await list(`from=${w.starts_at}&to=${w.ends_at}`)).map((m) => m.resource_id)).toEqual(['res_kitchen']);
  });

  it('lets Viewers see maintenance but not change it', async () => {
    const viewer = await sessionFor(env, 'viewer');
    expect((await call(maintenanceApi.onRequestGet, { env, cookie: viewer })).status).toBe(200);
    expect((await call(maintenanceApi.onRequestPost, { env, cookie: viewer, body: maintenance() })).status).toBe(403);
    expect((await call(maintenanceApi.onRequestGet, { env, cookie: customer })).status).toBe(403);
    expect((await call(faultsApi.onRequestPost, { env, cookie: viewer, body: { resource_id: 'res_main', description: 'Broken window', severity: 'low' } })).status).toBe(403);
  });

  it('only assigns maintenance to administrators', async () => {
    const res = await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance({ assigned_admin_id: 'u1' }) });
    expect(res.status).toBe(400);
  });
});

describe('maintenance over existing bookings (FR22 §4.6)', () => {
  it('refuses until the conflicts are acknowledged with a reason, and never cancels the bookings', async () => {
    const booking = await book('res_main', inDays(10, 13, 15));
    expect(booking.status).toBe(201);

    const refused = await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance() });
    expect(refused.status).toBe(409);
    expect(refused.body.details.code).toBe('conflicts');
    expect(refused.body.details.conflicts.map((b: { id: string }) => b.id)).toEqual([booking.body.id]);
    expect((await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance({ acknowledge_conflicts: true }) })).status).toBe(409);

    const saved = await call(maintenanceApi.onRequestPost, {
      env, cookie: admin, body: maintenance({ acknowledge_conflicts: true, exception_reason: 'Urgent electrical repair' }),
    });
    expect(saved.status).toBe(201);
    const id = saved.body.id;

    const status = await db.prepare('SELECT status FROM bookings WHERE id = ?').bind(booking.body.id).first<{ status: string }>();
    expect(status?.status).toBe('confirmed');
    const one = await call(maintenanceOne.onRequestGet, { env, cookie: admin, params: { id } });
    expect(one.body.conflict_exception_reason).toBe('Urgent electrical repair');
    expect(one.body.affected_bookings).toMatchObject([{ booking_id: booking.body.id, action_status: 'needs_action', status: 'confirmed' }]);

    // Editing it again does not ask for a new exception for the same booking.
    const edited = await call(maintenanceOne.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id }, body: maintenance({ title: 'Replace all hall lights' }) });
    expect(edited.status).toBe(200);

    const resolved = await call(affectedApi.onRequestPut, {
      env, cookie: admin, method: 'PUT', params: { id, bookingId: booking.body.id }, body: { status: 'resolved', resolution_note: 'Moved to the small hall' },
    });
    expect(resolved.status).toBe(200);
    const row = await db.prepare('SELECT status, resolution_note FROM maintenance_affected_bookings WHERE maintenance_id = ?').bind(id).first();
    expect(row).toEqual({ status: 'resolved', resolution_note: 'Moved to the small hall' });

    const reason = await db.prepare("SELECT reason FROM audit_events WHERE entity_id = ? AND action = 'maintenance.created'").bind(id).first<{ reason: string }>();
    expect(reason?.reason).toContain('Urgent electrical repair');
  });

  it('emails the customers of affected bookings once per version of the maintenance', async () => {
    const booking = await book('res_main', inDays(10, 13, 15));
    const saved = await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance({ acknowledge_conflicts: true, exception_reason: 'Urgent' }) });
    const id = saved.body.id;

    const sent = await call(notifyApi.onRequestPost, { env, cookie: admin, params: { id }, body: { message: 'Sorry for the disruption' } });
    expect(sent.status).toBe(200);
    expect(sent.body.notified).toBe(1);
    await call(notifyApi.onRequestPost, { env, cookie: admin, params: { id }, body: { message: 'Sorry for the disruption' } });
    const emails = await db.prepare("SELECT COUNT(*) AS n FROM email_events WHERE booking_id = ? AND template = 'maintenance_notice'").bind(booking.body.id).first<{ n: number }>();
    expect(emails?.n).toBe(1);

    const notified = await db.prepare('SELECT notified_at FROM maintenance_affected_bookings WHERE maintenance_id = ?').bind(id).first<{ notified_at: string | null }>();
    expect(notified?.notified_at).toBeTruthy();
    expect(await auditActions(id)).toContain('maintenance.customers_notified');

    const other = await book('res_kitchen', inDays(12));
    expect((await call(notifyApi.onRequestPost, { env, cookie: admin, params: { id }, body: { booking_ids: [other.body.id] } })).status).toBe(400);
  });
});

describe('maintenance-owned closures', () => {
  it('cannot be deleted from the closures list', async () => {
    const saved = await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance() });
    const closures = await call(closuresApi.onRequestGet, { env, cookie: admin, path: '/api/admin/closures?resource_id=res_main' });
    const owned = (closures.body as { id: string; maintenance_id: string | null }[]).find((c) => c.maintenance_id === saved.body.id);
    expect(owned).toBeTruthy();
    const res = await call(closuresApi.onRequestDelete, { env, cookie: admin, method: 'DELETE', body: { id: owned!.id } });
    expect(res.status).toBe(409);
    expect(res.body.details.code).toBe('owned');
  });
});

describe('maintenance types (FR22 §4.3)', () => {
  it('can be added and retired; retired types cannot be used for new work', async () => {
    const created = await call(typesApi.onRequestPost, { env, cookie: admin, body: { label: 'Fire safety check', sort_order: 7 } });
    expect(created.status).toBe(201);
    const typeId = created.body.id;
    expect((await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance({ maintenance_type_id: typeId, blocks_availability: false }) })).status).toBe(201);
    const { onRequestPut } = await import('../functions/api/admin/maintenance-types/[id]');
    expect((await call(onRequestPut, { env, cookie: admin, method: 'PUT', params: { id: typeId }, body: { label: 'Fire safety check', is_active: false } })).status).toBe(200);
    expect((await call(maintenanceApi.onRequestPost, { env, cookie: admin, body: maintenance({ maintenance_type_id: typeId, blocks_availability: false }) })).status).toBe(400);
  });
});

describe('faults (FR22 §4.7)', () => {
  it('blocks bookings while open when it prevents bookings, and keeps existing bookings', async () => {
    const existing = await book('res_main', inDays(5));
    const reported = await call(faultsApi.onRequestPost, {
      env, cookie: admin, body: { resource_id: 'res_main', description: 'Ceiling leak above the stage', severity: 'critical', blocks_bookings: true },
    });
    expect(reported.status).toBe(201);
    expect(reported.body.reference).toMatch(/^FLT-/);
    expect(reported.body.affected_bookings.map((b: { id: string }) => b.id)).toEqual([existing.body.id]);
    expect(await available('res_main', inDays(6))).toBe(false);
    expect((await book('res_main', inDays(6))).status).toBe(400);
    expect((await db.prepare('SELECT status FROM bookings WHERE id = ?').bind(existing.body.id).first<{ status: string }>())?.status).toBe('confirmed');

    const id = reported.body.id;
    const fixed = await call(faultOne.onRequestPut, {
      env, cookie: admin, method: 'PUT', params: { id },
      body: { resource_id: 'res_main', description: 'Ceiling leak above the stage', severity: 'critical', status: 'resolved', blocks_bookings: true, resolution_notes: 'Roof patched' },
    });
    expect(fixed.status).toBe(200);
    expect(await available('res_main', inDays(6))).toBe(true);
    const row = await db.prepare('SELECT resolved_at FROM resource_faults WHERE id = ?').bind(id).first<{ resolved_at: string | null }>();
    expect(row?.resolved_at).toBeTruthy();
    expect(await auditActions(id)).toEqual(['fault.reported', 'fault.resolved']);
  });

  it('does not block bookings when the fault allows them', async () => {
    await call(faultsApi.onRequestPost, { env, cookie: admin, body: { resource_id: 'res_main', description: 'Chipped paint on door', severity: 'low' } });
    expect(await available('res_main', inDays(6))).toBe(true);
    const list = await call(faultsApi.onRequestGet, { env, cookie: admin, path: '/api/admin/faults?status=open' });
    expect(list.body).toHaveLength(1);
  });
});
