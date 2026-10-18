import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as adminOrgs from '../functions/api/admin/organisations/index';
import * as org from '../functions/api/organisations/[id]';
import * as members from '../functions/api/organisations/[id]/members/index';
import * as member from '../functions/api/organisations/[id]/members/[userId]';
import * as invitations from '../functions/api/organisations/[id]/invitations/index';

let env: Env;
let db: D1Database;
let dispose: () => Promise<void>;
const cookies: Record<string, string> = {};

const ORG = {
  name: '1st Stratton Scout Group',
  organisation_type_id: 'scout_group',
  pricing_category_id: 'cat_scouts',
  contact_email: 'gsl@example.org',
  contact_phone: '01234 567890',
};

beforeEach(async () => {
  ({ env, db, dispose } = await createTestEnv());
  for (const id of ['leader', 'helper', 'outsider']) {
    await addUser(db, id);
    cookies[id] = await sessionFor(env, id);
  }
  for (const [id, role] of [['booker', 'booking_admin'], ['viewer', 'viewer']]) {
    await addAdmin(db, id, role);
    cookies[id] = await sessionFor(env, id);
  }
});

afterEach(async () => {
  await dispose();
});

const create = (body: Record<string, unknown>, who = 'booker') => call(adminOrgs.onRequestPost, { env, cookie: cookies[who], body });

async function audited(action: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM audit_events WHERE action = ?').bind(action).first<{ c: number }>();
  return row?.c ?? 0;
}

describe('administrators managing organisations', () => {
  it('creates an organisation with a registered user as its manager', async () => {
    const res = await create({ ...ORG, manager_email: 'leader@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.manager).toBe('added');
    const detail = await call(org.onRequestGet, { env, cookie: cookies.leader, params: { id: res.body.id } });
    expect(detail.body.my_role).toBe('manager');
    expect(await audited('organisation.created')).toBe(1);
  });

  it('invites the manager when they have no account yet', async () => {
    const res = await create({ ...ORG, manager_email: 'new.leader@example.org' });
    expect(res.body.manager).toBe('invited');
    const invite = await db.prepare('SELECT role, status FROM organisation_invitations WHERE organisation_id = ?').bind(res.body.id).first();
    expect(invite).toEqual({ role: 'manager', status: 'pending' });
  });

  it('lets an administrator edit details, add, promote and remove members, and invite', async () => {
    const id = (await create({ ...ORG, manager_email: 'leader@example.com' })).body.id as string;
    const admin = cookies.booker;

    const view = await call(org.onRequestGet, { env, cookie: admin, params: { id } });
    expect(view.body).toMatchObject({ my_role: null, can_manage: true });
    expect(view.body.invitations).toEqual([]);

    expect((await call(org.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id }, body: { ...ORG, name: 'Renamed Group' } })).status).toBe(200);
    expect((await call(members.onRequestPost, { env, cookie: admin, params: { id }, body: { email: 'helper@example.com' } })).status).toBe(201);
    expect((await call(members.onRequestPost, { env, cookie: admin, params: { id }, body: { email: 'helper@example.com' } })).status).toBe(409);
    expect((await call(members.onRequestPost, { env, cookie: admin, params: { id }, body: { email: 'nobody@example.com' } })).status).toBe(404);
    expect((await call(member.onRequestPut, { env, cookie: admin, method: 'PUT', params: { id, userId: 'helper' }, body: { role: 'manager' } })).status).toBe(200);
    expect((await call(member.onRequestDelete, { env, cookie: admin, method: 'DELETE', params: { id, userId: 'leader' } })).status).toBe(200);
    // The last manager still cannot be removed, even by an administrator.
    expect((await call(member.onRequestDelete, { env, cookie: admin, method: 'DELETE', params: { id, userId: 'helper' } })).status).toBe(409);
    expect((await call(invitations.onRequestPost, { env, cookie: admin, params: { id }, body: { email: 'someone@example.org' } })).status).toBe(201);

    const after = await call(org.onRequestGet, { env, cookie: admin, params: { id } });
    expect(after.body.name).toBe('Renamed Group');
    expect(after.body.members).toEqual([expect.objectContaining({ user_id: 'helper', role: 'manager' })]);
    expect(await audited('organisation.member_added')).toBe(1);
  });

  it('keeps Viewers and customers out', async () => {
    const id = (await create({ ...ORG, manager_email: 'leader@example.com' })).body.id as string;
    expect((await create({ ...ORG, manager_email: 'leader@example.com' }, 'viewer')).status).toBe(403);
    expect((await create({ ...ORG, manager_email: 'leader@example.com' }, 'outsider')).status).toBe(403);
    const viewer = await call(org.onRequestGet, { env, cookie: cookies.viewer, params: { id } });
    expect(viewer.body.can_manage).toBe(false);
    expect((await call(org.onRequestPut, { env, cookie: cookies.viewer, method: 'PUT', params: { id }, body: ORG })).status).toBe(403);
    expect((await call(members.onRequestPost, { env, cookie: cookies.viewer, params: { id }, body: { email: 'helper@example.com' } })).status).toBe(403);
    expect((await call(invitations.onRequestPost, { env, cookie: cookies.outsider, params: { id }, body: { email: 'x@example.org' } })).status).toBe(403);
  });
});
