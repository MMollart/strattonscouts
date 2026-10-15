import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import { changeMembership, inviteToOrganisation, respondToInvitation } from '../functions/_lib/organisations';
import { loadAccess } from '../functions/_lib/auth';
import * as orgs from '../functions/api/organisations/index';
import * as org from '../functions/api/organisations/[id]';
import * as invitations from '../functions/api/organisations/[id]/invitations/index';
import * as invitation from '../functions/api/organisations/[id]/invitations/[invitationId]';
import * as member from '../functions/api/organisations/[id]/members/[userId]';
import * as invite from '../functions/api/invitations/[token]';
import * as bookings from '../functions/api/bookings/index';
import * as booking from '../functions/api/bookings/[id]';
import * as cancel from '../functions/api/bookings/[id]/cancel';

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
  for (const id of ['manager', 'member', 'outsider', 'invitee']) {
    await addUser(db, id, 'cat_public');
    cookies[id] = await sessionFor(env, id);
  }
  await addAdmin(db, 'viewer', 'viewer');
  cookies.viewer = await sessionFor(env, 'viewer');
});

afterEach(async () => {
  await dispose();
});

async function createOrg(by = 'manager', input = ORG): Promise<string> {
  const res = await call(orgs.onRequestPost, { env, cookie: cookies[by], body: input });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function addMember(orgId: string, userId: string, role: 'member' | 'manager' = 'member') {
  const r = await inviteToOrganisation(env, { organisationId: orgId, email: `${userId}@example.com`, role, invitedBy: { id: 'manager', full_name: 'M' } });
  if (!r.ok) throw new Error(r.code);
  const accepted = await respondToInvitation(env, { token: r.token, user: { id: userId, email: `${userId}@example.com` }, action: 'accept' });
  expect(accepted.ok).toBe(true);
  return r;
}

const window = { starts_at: '2027-06-01T10:00:00.000Z', ends_at: '2027-06-01T12:00:00.000Z' };

describe('organisations (FR01)', () => {
  it('creates an organisation and makes the creator its manager', async () => {
    const id = await createOrg();
    const detail = await call(org.onRequestGet, { env, cookie: cookies.manager, params: { id } });
    expect(detail.body).toMatchObject({ name: ORG.name, my_role: 'manager', contact_phone: ORG.contact_phone });
    expect(detail.body.members).toEqual([expect.objectContaining({ user_id: 'manager', role: 'manager' })]);
    // Names need not be unique.
    const second = await createOrg('outsider');
    expect(second).not.toBe(id);
  });

  it('lets a user belong to several organisations', async () => {
    const a = await createOrg();
    const b = await createOrg('outsider', { ...ORG, name: 'Explorers' });
    await addMember(a, 'member');
    await inviteToOrganisation(env, { organisationId: b, email: 'member@example.com', role: 'member', invitedBy: { id: 'outsider', full_name: 'O' } }).then(async (r) => {
      if (r.ok) await respondToInvitation(env, { token: r.token, user: { id: 'member', email: 'member@example.com' }, action: 'accept' });
    });
    const mine = await call(orgs.onRequestGet, { env, cookie: cookies.member });
    expect(mine.body.map((o: { id: string }) => o.id).sort()).toEqual([a, b].sort());
  });

  it('keeps organisation details private to members and administrators', async () => {
    const id = await createOrg();
    expect((await call(org.onRequestGet, { env, cookie: cookies.outsider, params: { id } })).status).toBe(403);
    expect((await call(org.onRequestGet, { env, cookie: cookies.viewer, params: { id } })).status).toBe(200);
    expect((await call(org.onRequestPut, { env, cookie: cookies.outsider, method: 'PUT', params: { id }, body: ORG })).status).toBe(403);
  });
});

describe('invitations (FR01)', () => {
  it('only managers can invite', async () => {
    const id = await createOrg();
    await addMember(id, 'member');
    expect((await call(invitations.onRequestPost, { env, cookie: cookies.member, params: { id }, body: { email: 'x@example.com' } })).status).toBe(403);
    expect((await call(invitations.onRequestPost, { env, cookie: cookies.manager, params: { id }, body: { email: 'X@Example.com' } })).status).toBe(201);
  });

  it('stores only a hash of the single-use token and emails the link', async () => {
    const id = await createOrg();
    const r = await inviteToOrganisation(env, { organisationId: id, email: 'invitee@example.com', role: 'member', invitedBy: { id: 'manager', full_name: 'M' } });
    if (!r.ok) throw new Error();
    const row = await db.prepare('SELECT token_hash FROM organisation_invitations WHERE id = ?').bind(r.invitationId).first<{ token_hash: string }>();
    expect(row?.token_hash).not.toContain(r.token);
    const email = await db.prepare("SELECT recipient FROM email_events WHERE template = 'organisation_invitation'").first<{ recipient: string }>();
    expect(email?.recipient).toBe('invitee@example.com');

    const user = { id: 'invitee', email: 'invitee@example.com' };
    expect(await respondToInvitation(env, { token: r.token, user, action: 'accept' })).toMatchObject({ ok: true });
    expect(await respondToInvitation(env, { token: r.token, user, action: 'accept' })).toMatchObject({ ok: false, code: 'not_pending' });
  });

  it('must be accepted by the intended recipient', async () => {
    const id = await createOrg();
    const r = await inviteToOrganisation(env, { organisationId: id, email: 'invitee@example.com', role: 'manager', invitedBy: { id: 'manager', full_name: 'M' } });
    if (!r.ok) throw new Error();
    const wrong = await call(invite.onRequestPost, { env, cookie: cookies.outsider, params: { token: r.token }, body: { action: 'accept' } });
    expect(wrong.status).toBe(403);
    const look = await call(invite.onRequestGet, { env, cookie: cookies.outsider, params: { token: r.token } });
    expect(look.body).toMatchObject({ is_recipient: false, email: 'i***@example.com', status: 'pending' });
    const ok = await call(invite.onRequestPost, { env, cookie: cookies.invitee, params: { token: r.token }, body: { action: 'accept' } });
    expect(ok.status).toBe(200);
    // A manager invitation grants an organisation role only, never platform permissions.
    expect((await loadAccess(env, 'invitee')).roles).toEqual([]);
  });

  it('prevents duplicate active invitations and allows revoking', async () => {
    const id = await createOrg();
    const first = await call(invitations.onRequestPost, { env, cookie: cookies.manager, params: { id }, body: { email: 'invitee@example.com' } });
    const dup = await call(invitations.onRequestPost, { env, cookie: cookies.manager, params: { id }, body: { email: 'invitee@example.com' } });
    expect(dup.status).toBe(409);
    expect((await call(invitation.onRequestDelete, { env, cookie: cookies.manager, method: 'DELETE', params: { id, invitationId: first.body.id } })).status).toBe(200);
    expect((await call(invitations.onRequestPost, { env, cookie: cookies.manager, params: { id }, body: { email: 'invitee@example.com' } })).status).toBe(201);
  });

  it('expires invitations', async () => {
    const id = await createOrg();
    const r = await inviteToOrganisation(env, { organisationId: id, email: 'invitee@example.com', role: 'member', invitedBy: { id: 'manager', full_name: 'M' } });
    if (!r.ok) throw new Error();
    await db.prepare("UPDATE organisation_invitations SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(await respondToInvitation(env, { token: r.token, user: { id: 'invitee', email: 'invitee@example.com' }, action: 'accept' })).toMatchObject({ ok: false, code: 'not_pending' });
    // An expired invitation no longer blocks a fresh one.
    expect((await inviteToOrganisation(env, { organisationId: id, email: 'invitee@example.com', role: 'member', invitedBy: { id: 'manager', full_name: 'M' } })).ok).toBe(true);
  });

  it('declining does not create a membership', async () => {
    const id = await createOrg();
    const r = await inviteToOrganisation(env, { organisationId: id, email: 'invitee@example.com', role: 'member', invitedBy: { id: 'manager', full_name: 'M' } });
    if (!r.ok) throw new Error();
    expect((await respondToInvitation(env, { token: r.token, user: { id: 'invitee', email: 'invitee@example.com' }, action: 'decline' })).ok).toBe(true);
    const m = await db.prepare("SELECT COUNT(*) AS c FROM organisation_memberships WHERE user_id = 'invitee'").first<{ c: number }>();
    expect(m?.c).toBe(0);
  });
});

describe('membership management (FR01)', () => {
  it('promotes, demotes and removes members, never the last manager', async () => {
    const id = await createOrg();
    await addMember(id, 'member');
    const put = (userId: string, role: string, by = 'manager') => call(member.onRequestPut, { env, cookie: cookies[by], method: 'PUT', params: { id, userId }, body: { role } });
    expect((await put('member', 'manager', 'member')).status).toBe(403);
    expect((await put('manager', 'member')).status).toBe(409);
    expect((await put('member', 'manager')).status).toBe(200);
    expect((await put('manager', 'member')).status).toBe(200);
    // 'member' is now the only manager and cannot leave.
    expect((await call(member.onRequestDelete, { env, cookie: cookies.member, method: 'DELETE', params: { id, userId: 'member' } })).status).toBe(409);
    expect((await call(member.onRequestDelete, { env, cookie: cookies.member, method: 'DELETE', params: { id, userId: 'manager' } })).status).toBe(200);
  });

  it('allows only one of two simultaneous demotions of the last two managers', async () => {
    const id = await createOrg();
    await addMember(id, 'member', 'manager');
    const results = await Promise.all([
      changeMembership(env, { organisationId: id, userId: 'manager', role: 'member' }),
      changeMembership(env, { organisationId: id, userId: 'member', role: null }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const managers = await db.prepare("SELECT COUNT(*) AS c FROM organisation_memberships WHERE organisation_id = ? AND role = 'manager'").bind(id).first<{ c: number }>();
    expect(managers?.c).toBe(1);
  });
});

describe('organisation bookings (FR01)', () => {
  it('books on behalf of an organisation at its pricing category', async () => {
    const id = await createOrg();
    await addMember(id, 'member');
    // Member is in the public category personally; the organisation is Scouts.
    const personal = await call(bookings.onRequestPost, { env, cookie: cookies.member, body: { resource_id: 'res_main', ...window } });
    expect(personal.body.total_amount_pence).toBe(4000);
    const orgBooking = await call(bookings.onRequestPost, {
      env, cookie: cookies.member,
      body: { resource_id: 'res_small', ...window, organisation_id: id },
    });
    expect(orgBooking.status).toBe(201);
    expect(orgBooking.body.total_amount_pence).toBe(1000);
    const row = await db.prepare('SELECT organisation_id, user_id, created_by, category_id FROM bookings WHERE id = ?').bind(orgBooking.body.id).first();
    expect(row).toEqual({ organisation_id: id, user_id: 'member', created_by: 'member', category_id: 'cat_scouts' });
  });

  it('refuses organisation bookings from non-members', async () => {
    const id = await createOrg();
    const res = await call(bookings.onRequestPost, { env, cookie: cookies.outsider, body: { resource_id: 'res_main', ...window, organisation_id: id } });
    expect(res.status).toBe(403);
  });

  it('shows organisation bookings to members and lets managers manage them', async () => {
    const id = await createOrg();
    await addMember(id, 'member');
    await addMember(id, 'invitee');
    const made = await call(bookings.onRequestPost, { env, cookie: cookies.member, body: { resource_id: 'res_main', ...window, organisation_id: id } });
    const bookingId = made.body.id;

    const list = await call(bookings.onRequestGet, { env, cookie: cookies.invitee });
    expect(list.body.map((b: { id: string }) => b.id)).toEqual([bookingId]);
    expect(list.body[0]).toMatchObject({ organisation_name: ORG.name, is_mine: false });

    expect((await call(booking.onRequestGet, { env, cookie: cookies.invitee, params: { id: bookingId } })).body.can_manage).toBe(false);
    expect((await call(booking.onRequestGet, { env, cookie: cookies.outsider, params: { id: bookingId } })).status).toBe(403);
    expect((await call(cancel.onRequestPost, { env, cookie: cookies.invitee, params: { id: bookingId } })).status).toBe(403);
    expect((await call(cancel.onRequestPost, { env, cookie: cookies.manager, params: { id: bookingId } })).status).toBe(200);
  });

  it('leaves personal bookings visible only to their customer', async () => {
    const id = await createOrg();
    await addMember(id, 'member');
    await call(bookings.onRequestPost, { env, cookie: cookies.member, body: { resource_id: 'res_main', ...window } });
    expect((await call(bookings.onRequestGet, { env, cookie: cookies.manager })).body).toEqual([]);
  });
});
