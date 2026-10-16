import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import { diff, recordAudit, sanitise, sealAuditEvents, verifyAuditChain } from '../functions/_lib/audit';
import { expireProvisionalBookings } from '../functions/_lib/provisional';
import { setAdminRole } from '../functions/_lib/admins';
import { changeMembership } from '../functions/_lib/organisations';
import * as bookingsApi from '../functions/api/bookings/index';
import * as decideApi from '../functions/api/admin/bookings/[id]';
import * as cancelApi from '../functions/api/bookings/[id]/cancel';
import * as amendApi from '../functions/api/bookings/[id]/amendments/index';
import * as decideAmendmentApi from '../functions/api/admin/amendments/[id]';
import * as rateApi from '../functions/api/admin/pricing/rates/[id]';
import * as categoryApi from '../functions/api/admin/categories/[id]';
import * as resourceApi from '../functions/api/admin/resources/[id]';
import * as orgsApi from '../functions/api/organisations/index';
import * as assetTypes from '../functions/api/admin/asset-types/index';
import * as assets from '../functions/api/admin/assets/index';
import * as assign from '../functions/api/admin/assets/[id]/assign';
import * as auditApi from '../functions/api/admin/audit/index';
import * as auditExport from '../functions/api/admin/audit/export';
import * as auditVerify from '../functions/api/admin/audit/verify';

let env: Env;
let db: D1Database;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ env, db, dispose } = await createTestEnv());
  await addUser(db, 'u1');
  await addAdmin(db, 'booker', 'booking_admin');
  await addAdmin(db, 'viewer', 'viewer');
  await addAdmin(db, 'super', 'super_admin');
});
afterEach(async () => {
  await dispose();
});

const inDays = (days: number, from = 10, to = 12) => {
  const d = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  return { starts_at: `${d}T${String(from).padStart(2, '0')}:00:00.000Z`, ends_at: `${d}T${String(to).padStart(2, '0')}:00:00.000Z` };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are untyped in tests
async function events(where = '1 = 1', ...binds: unknown[]): Promise<Record<string, any>[]> {
  const rows = await db.prepare(`SELECT * FROM audit_events WHERE ${where} ORDER BY seq`).bind(...binds).all<Record<string, string | null>>();
  return rows.results.map((r) => ({ ...r, before: r.before_json ? JSON.parse(r.before_json) : null, after: r.after_json ? JSON.parse(r.after_json) : null }));
}

describe('audit values (FR11 §6.8)', () => {
  it('never records credentials or contact details', () => {
    expect(sanitise({ password_hash: 'x', token_hash: 'y', contact_email: 'a@b.c', phone: '0123', name: 'Hall', updated_at: 'now' })).toEqual({
      password_hash: '[redacted]', token_hash: '[redacted]', contact_email: '[redacted]', phone: '[redacted]', name: 'Hall',
    });
  });

  it('keeps only the fields that changed', () => {
    expect(diff({ a: 1, b: 2, updated_at: 'x' }, { a: 1, b: 3, updated_at: 'y' })).toEqual({ before: { b: 2 }, after: { b: 3 } });
    expect(diff(null, { a: 1 })).toEqual({ before: null, after: { a: 1 } });
  });
});

describe('booking audit (FR11 §6.2)', () => {
  it('records creation, approval, amendment and cancellation with actors and values', async () => {
    const customer = await sessionFor(env, 'u1');
    const admin = await sessionFor(env, 'booker');
    const created = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_field', ...inDays(20) } });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await call(decideApi.onRequestPost, { env, cookie: admin, params: { id }, body: { decision: 'approve' } })).status).toBe(200);

    const req = await call(amendApi.onRequestPost, { env, cookie: customer, params: { id }, body: { resource_id: 'res_field', ...inDays(21), note: 'Rain date' } });
    expect(req.status).toBe(201);
    expect((await call(decideAmendmentApi.onRequestPost, { env, cookie: admin, params: { id: req.body.id }, body: { decision: 'approve', note: 'Fine' } })).status).toBe(200);
    expect((await call(cancelApi.onRequestPost, { env, cookie: customer, params: { id } })).status).toBe(200);

    const log = await events('booking_id = ?', id);
    expect(log.map((e) => [e.action, e.actor_id, e.actor_type])).toEqual([
      ['booking.created', 'u1', 'customer'],
      ['booking.approved', 'booker', 'administrator'],
      ['booking.amendment_requested', 'u1', 'customer'],
      ['booking.amended', 'booker', 'administrator'],
      ['booking.cancelled', 'u1', 'customer'],
    ]);
    expect(log[1].before).toEqual({ status: 'pending_approval' });
    expect(log[1].after).toEqual({ status: 'confirmed' });
    expect(log[2].reason).toBe('Rain date');
    expect(log[3].before.starts_at).toBe(inDays(20).starts_at);
    expect(log[3].after.starts_at).toBe(inDays(21).starts_at);
    expect(log[3].reason).toBe('Fine');
    expect(log[0].entity_label).toBe(created.body.reference);
    expect(log[0].resource_id).toBe('res_field');
  });

  it('attributes provisional expiry to the system', async () => {
    const customer = await sessionFor(env, 'u1');
    const res = await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...inDays(10), provisional: true } });
    await db.prepare("UPDATE bookings SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute') WHERE id = ?").bind(res.body.id).run();
    expect(await expireProvisionalBookings(env)).toBe(1);
    const [expired] = await events("booking_id = ? AND action = 'booking.expired'", res.body.id);
    expect(expired.actor_id).toBeNull();
    expect(expired.actor_type).toBe('system');
  });
});

describe('administration audit (FR11 §6.2)', () => {
  it('records pricing changes with the previous and new price', async () => {
    const cookie = await sessionFor(env, 'super');
    const res = await call(rateApi.onRequestPut, {
      env, cookie, method: 'PUT', params: { id: 'rate_pr_main_p' },
      body: { resource_id: 'res_main', pricing_model: 'hourly', amount_pence: 3000, effective_from: '1970-01-01T00:00:00.000Z', is_active: true },
    });
    expect(res.status).toBe(200);
    const [e] = await events("action = 'pricing.rate_updated'");
    expect(e).toMatchObject({ actor_id: 'super', entity_type: 'base_rate', entity_id: 'rate_pr_main_p', entity_label: 'Main Hall', resource_id: 'res_main' });
    expect(e.before).toEqual({ amount_pence: 2000 });
    expect(e.after).toEqual({ amount_pence: 3000 });

    await call(categoryApi.onRequestPut, { env, cookie, method: 'PUT', params: { id: 'cat_community' }, body: { label: 'Other Community Organisations (incl. Girlguiding)', sort_order: 2, is_active: true, discount_bp: 3000 } });
    const [cat] = await events("action = 'pricing.category_updated'");
    expect(cat.before).toEqual({ discount_bp: 2500 });
    expect(cat.after).toEqual({ discount_bp: 3000 });
  });

  it('records nothing when a save changes nothing', async () => {
    const cookie = await sessionFor(env, 'super');
    const body = { resource_id: 'res_main', pricing_model: 'hourly', amount_pence: 2000, effective_from: '1970-01-01T00:00:00.000Z', is_active: true };
    await call(rateApi.onRequestPut, { env, cookie, method: 'PUT', params: { id: 'rate_pr_main_p' }, body });
    expect(await events("action = 'pricing.rate_updated'")).toHaveLength(0);
  });

  it('records resource changes, administrator roles, memberships and asset loans', async () => {
    const cookie = await sessionFor(env, 'booker');
    const resource = await db.prepare("SELECT * FROM resources WHERE id = 'res_kitchen'").first<Record<string, unknown>>();
    await call(resourceApi.onRequestPut, {
      env, cookie, method: 'PUT', params: { id: 'res_kitchen' },
      body: { name: 'Kitchen', slug: 'kitchen', description: resource!.description, parent_id: resource!.parent_id, is_active: false, requires_approval: false, pricing_model: 'hourly' },
    });
    const [r] = await events("action = 'resource.updated'");
    expect(r.before).toEqual({ is_active: 1 });
    expect(r.after).toEqual({ is_active: 0 });

    await setAdminRole(env, { userId: 'u1', role: 'viewer', actorId: 'super' });
    const [role] = await events("action = 'admin.role_changed' AND entity_id = 'u1'");
    expect(role).toMatchObject({ actor_id: 'super', actor_type: 'administrator' });
    expect(role.after).toEqual({ role: 'viewer' });

    const org = await call(orgsApi.onRequestPost, {
      env, cookie: await sessionFor(env, 'u1'),
      body: { name: 'Beavers', organisation_type_id: 'scout_group', pricing_category_id: 'cat_scouts', contact_email: 'b@example.com', contact_phone: '01234 567890' },
    });
    expect(org.status).toBe(201);
    await addUser(db, 'u2');
    await db.prepare("INSERT INTO organisation_memberships (organisation_id, user_id, role, created_at, updated_at) VALUES (?, 'u2', 'member', 'x', 'x')").bind(org.body.id).run();
    expect((await changeMembership(env, { organisationId: org.body.id, userId: 'u2', role: 'manager', actor: { id: 'u1', type: 'customer' } })).ok).toBe(true);
    const orgLog = await events('organisation_id = ?', org.body.id);
    expect(orgLog.map((e) => e.action)).toEqual(['organisation.created', 'organisation.member_role_changed']);
    expect(orgLog[1].before).toEqual({ user_id: 'u2', role: 'member' });

    const type = await call(assetTypes.onRequestPost, { env, cookie, body: { name: 'Tent', description: '', sort_order: 1, is_active: true } });
    const asset = await call(assets.onRequestPost, { env, cookie, body: { asset_type_id: type.body.id, name: 'Tent 1', description: '', reference: 'T1' } });
    expect((await call(assign.onRequestPost, { env, cookie, params: { id: asset.body.id }, body: { user_id: 'u1', notes: '' } })).status).toBe(201);
    expect((await events("entity_type = 'asset'")).map((e) => e.action)).toEqual(['asset.created', 'asset.assigned']);
  });
});

describe('audit integrity (FR11 §6.7)', () => {
  it('refuses to change or delete audit records', async () => {
    await recordAudit(env, { actor: { id: null, type: 'system' }, action: 'test.event', entityType: 'test', entityId: 'x' });
    await expect(db.prepare("UPDATE audit_events SET action = 'tampered'").run()).rejects.toThrow(/append-only/);
    await expect(db.prepare('DELETE FROM audit_events').run()).rejects.toThrow(/append-only/);
    // Sealing is the one permitted update, and only once.
    expect(await sealAuditEvents(env)).toBe(1);
    await expect(db.prepare("UPDATE audit_events SET hash = 'x'").run()).rejects.toThrow(/append-only/);
  });

  it('chains sealed records so a later edit is detected', async () => {
    for (let i = 0; i < 3; i++) await recordAudit(env, { actor: { id: 'super', type: 'administrator' }, action: 'test.event', entityType: 'test', entityId: `e${i}` });
    await sealAuditEvents(env);
    expect(await sealAuditEvents(env)).toBe(0);
    const good = await verifyAuditChain(env);
    expect(good).toMatchObject({ ok: true, checked: 3, unsealed: 0 });

    // Someone with database access bypasses the protection.
    await db.prepare('DROP TRIGGER audit_events_no_update').run();
    await db.prepare("UPDATE audit_events SET entity_id = 'forged' WHERE entity_id = 'e1'").run();
    const bad = await verifyAuditChain(env);
    expect(bad.ok).toBe(false);
    expect(bad.checked).toBe(1);
  });
});

describe('audit history API (FR11 §6.4, §8)', () => {
  beforeEach(async () => {
    const customer = await sessionFor(env, 'u1');
    await call(bookingsApi.onRequestPost, { env, cookie: customer, body: { resource_id: 'res_main', ...inDays(5) } });
    await recordAudit(env, { actor: { id: 'super', type: 'administrator' }, action: 'pricing.rate_updated', entityType: 'base_rate', entityId: 'r1', before: { amount_pence: 1 }, after: { amount_pence: 2 }, reason: 'Annual review' });
  });

  it('gives administrators full history and filters it', async () => {
    const cookie = await sessionFor(env, 'booker');
    const all = await call(auditApi.onRequestGet, { env, cookie, path: '/api/admin/audit' });
    expect(all.status).toBe(200);
    expect(all.body.access).toBe('full');
    expect(all.body.events.map((e: { action: string }) => e.action)).toEqual(['pricing.rate_updated', 'booking.confirmed']);
    expect(all.body.events[0].after).toEqual({ amount_pence: 2 });
    expect(all.body.events.every((e: { sealed: boolean }) => e.sealed)).toBe(true);

    const bookings = await call(auditApi.onRequestGet, { env, cookie, path: '/api/admin/audit?action=booking.' });
    expect(bookings.body.events.map((e: { action: string }) => e.action)).toEqual(['booking.confirmed']);
    const byUser = await call(auditApi.onRequestGet, { env, cookie, path: '/api/admin/audit?actor_id=u1' });
    expect(byUser.body.events).toHaveLength(1);
    const ref = byUser.body.events[0].booking_reference;
    expect((await call(auditApi.onRequestGet, { env, cookie, path: `/api/admin/audit?booking_reference=${ref}` })).body.events).toHaveLength(1);
    const today = new Date().toISOString().slice(0, 10);
    expect((await call(auditApi.onRequestGet, { env, cookie, path: `/api/admin/audit?from=2000-01-01&to=2000-12-31` })).body.events).toHaveLength(0);
    expect((await call(auditApi.onRequestGet, { env, cookie, path: `/api/admin/audit?from=${today}` })).body.events.length).toBeGreaterThan(0);
    const paged = await call(auditApi.onRequestGet, { env, cookie, path: '/api/admin/audit?limit=1' });
    expect(paged.body.events).toHaveLength(1);
    const next = await call(auditApi.onRequestGet, { env, cookie, path: `/api/admin/audit?limit=1&before=${paged.body.next_before}` });
    expect(next.body.events[0].action).toBe('booking.confirmed');
  });

  it('restricts Viewers to who, what and when', async () => {
    const res = await call(auditApi.onRequestGet, { env, cookie: await sessionFor(env, 'viewer'), path: '/api/admin/audit' });
    expect(res.body.access).toBe('restricted');
    expect(res.body.events[0]).toMatchObject({ action: 'pricing.rate_updated', before: null, after: null, reason: null });
  });

  it('refuses customers and lets only Super Admins export', async () => {
    expect((await call(auditApi.onRequestGet, { env, cookie: await sessionFor(env, 'u1'), path: '/api/admin/audit' })).status).toBe(403);
    expect((await call(auditExport.onRequestGet, { env, cookie: await sessionFor(env, 'booker'), path: '/api/admin/audit/export' })).status).toBe(403);
    const csv = await call(auditExport.onRequestGet, { env, cookie: await sessionFor(env, 'super'), path: '/api/admin/audit/export?entity_type=base_rate' });
    expect(csv.status).toBe(200);
    const lines = String(csv.body).replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toContain('"Event ID","Sequence","Timestamp (UTC)"');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"pricing.rate_updated"');
    expect(lines[1]).toContain('"Annual review"');
  });

  it('checks the chain on request', async () => {
    const res = await call(auditVerify.onRequestPost, { env, cookie: await sessionFor(env, 'booker'), body: {} });
    expect(res.body).toMatchObject({ ok: true, checked: 2, unsealed: 0 });
    expect((await call(auditVerify.onRequestPost, { env, cookie: await sessionFor(env, 'viewer'), body: {} })).status).toBe(403);
  });
});

describe('audit migration (0017)', () => {
  it('copies earlier booking and role history in time order', async () => {
    const t = await createTestEnv({ stopBefore: '0017' });
    try {
      await addUser(t.db, 'c');
      await addAdmin(t.db, 'a', 'booking_admin');
      await t.db.batch([
        t.db.prepare(`INSERT INTO bookings (id, reference, user_id, resource_id, starts_at, ends_at, status, category_id, pricing_model, unit_price_pence, total_amount_pence, created_at, updated_at)
          VALUES ('b1', 'SS-OLD001', 'c', 'res_main', '2026-01-01T10:00:00.000Z', '2026-01-01T12:00:00.000Z', 'confirmed', 'cat_scouts', 'hourly', 1000, 2000, '2025-12-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z')`),
        t.db.prepare("INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at) VALUES ('e2', 'b1', 'approved', 'a', NULL, '2025-12-02T00:00:00.000Z')"),
        t.db.prepare("INSERT INTO booking_events (id, booking_id, event_type, actor_id, detail, created_at) VALUES ('e1', 'b1', 'created', 'c', NULL, '2025-12-01T00:00:00.000Z')"),
        t.db.prepare("INSERT INTO admin_role_events (id, user_id, from_role, to_role, actor_id, created_at) VALUES ('r1', 'c', NULL, 'viewer', 'a', '2025-12-03T00:00:00.000Z')"),
      ]);
      await t.applyRemaining();
      const rows = await t.db.prepare('SELECT action, actor_type, entity_label, booking_id FROM audit_events ORDER BY seq').all();
      expect(rows.results).toEqual([
        { action: 'booking.created', actor_type: 'customer', entity_label: 'SS-OLD001', booking_id: 'b1' },
        { action: 'booking.approved', actor_type: 'administrator', entity_label: 'SS-OLD001', booking_id: 'b1' },
        { action: 'admin.role_changed', actor_type: 'administrator', entity_label: null, booking_id: null },
      ]);
    } finally {
      await t.dispose();
    }
  });
});
