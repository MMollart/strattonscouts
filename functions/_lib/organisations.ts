import type { Env } from './http';
import { newId, now } from './http';
import { randomToken, sha256Hex } from './crypto';
import { abortIf, guardedBatch } from './txn';
import { getIntSetting, getSetting } from './settings';
import { sendEmail } from './email';
import type { OrganisationRole } from '@shared/validation';
import { auditStatement, userActor, SYSTEM_ACTOR, type AuditActor } from './audit';
import { can, type AuthUser } from './auth';

/** The user's role in an organisation, or null if they are not a member. */
export async function getMembershipRole(env: Env, organisationId: string, userId: string): Promise<OrganisationRole | null> {
  const row = await env.DB.prepare('SELECT role FROM organisation_memberships WHERE organisation_id = ? AND user_id = ?')
    .bind(organisationId, userId)
    .first<{ role: OrganisationRole }>();
  return row?.role ?? null;
}

/**
 * What a user may do with an organisation: its Organisation Managers, and
 * administrators who manage bookings and customers (bookings.manage), may
 * change its details, members and invitations.
 */
export async function organisationAccess(
  env: Env,
  organisationId: string,
  user: AuthUser,
): Promise<{ role: OrganisationRole | null; canManage: boolean }> {
  const role = await getMembershipRole(env, organisationId, user.id);
  return { role, canManage: role === 'manager' || can(user, 'bookings.manage') };
}

const MANAGER_COUNT_SQL = `(SELECT COUNT(*) FROM organisation_memberships WHERE organisation_id = ? AND role = 'manager')`;
const IS_MANAGER_SQL = `EXISTS (SELECT 1 FROM organisation_memberships WHERE organisation_id = ? AND user_id = ? AND role = 'manager')`;

export type MembershipChangeResult = { ok: true } | { ok: false; code: 'not_member' | 'last_manager' };

/**
 * Change a member's role or remove them (role null). One guarded batch, so an
 * organisation can never be left without a manager, even under concurrency.
 */
export async function changeMembership(
  env: Env,
  args: { organisationId: string; userId: string; role: OrganisationRole | null; actor?: AuditActor },
): Promise<MembershipChangeResult> {
  const current = await getMembershipRole(env, args.organisationId, args.userId);
  if (!current) return { ok: false, code: 'not_member' };
  const statements: D1PreparedStatement[] = [];
  if (args.role !== 'manager') {
    statements.push(
      abortIf(env, `${IS_MANAGER_SQL} AND ${MANAGER_COUNT_SQL} <= 1`, args.organisationId, args.userId, args.organisationId),
    );
  }
  statements.push(
    args.role
      ? env.DB.prepare('UPDATE organisation_memberships SET role = ?, updated_at = ? WHERE organisation_id = ? AND user_id = ?').bind(
          args.role,
          now(),
          args.organisationId,
          args.userId,
        )
      : env.DB.prepare('DELETE FROM organisation_memberships WHERE organisation_id = ? AND user_id = ?').bind(args.organisationId, args.userId),
    auditStatement(
      env,
      {
        actor: args.actor ?? SYSTEM_ACTOR,
        action: args.role ? 'organisation.member_role_changed' : 'organisation.member_removed',
        entityType: 'organisation_membership',
        entityId: `${args.organisationId}:${args.userId}`,
        before: { user_id: args.userId, role: current },
        after: args.role ? { user_id: args.userId, role: args.role } : null,
        organisationId: args.organisationId,
      },
      { onlyIfChanged: true },
    ),
  );
  const result = await guardedBatch(env, statements);
  return result ? { ok: true } : { ok: false, code: 'last_manager' };
}

export type InviteResult =
  | { ok: true; invitationId: string; token: string }
  | { ok: false; code: 'already_member' | 'already_invited' };

/**
 * Invite an email address to an organisation. Generates a single-use token
 * (only its hash is stored) and emails the link. Stale pending invitations are
 * marked expired first so the one-active-invitation index stays meaningful.
 */
export async function inviteToOrganisation(
  env: Env,
  args: { organisationId: string; email: string; role: OrganisationRole; invitedBy: { id: string; full_name: string; roles?: readonly string[] } },
): Promise<InviteResult> {
  const email = args.email.toLowerCase();
  const ts = now();
  const member = await env.DB.prepare(
    `SELECT 1 FROM organisation_memberships m JOIN users u ON u.id = m.user_id WHERE m.organisation_id = ? AND u.email = ?`,
  )
    .bind(args.organisationId, email)
    .first();
  if (member) return { ok: false, code: 'already_member' };

  await env.DB.prepare(
    `UPDATE organisation_invitations SET status = 'expired' WHERE organisation_id = ? AND email = ? AND status = 'pending' AND expires_at <= ?`,
  )
    .bind(args.organisationId, email, ts)
    .run();

  const days = await getIntSetting(env, 'invitation_expiry_days', 7);
  const expiresAt = new Date(Date.now() + Math.max(1, days) * 86_400_000).toISOString();
  const token = randomToken(32);
  const id = newId('inv');
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO organisation_invitations (id, organisation_id, email, role, token_hash, status, invited_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).bind(id, args.organisationId, email, args.role, await sha256Hex(token), args.invitedBy.id, ts, expiresAt),
      auditStatement(env, {
        actor: userActor(args.invitedBy),
        action: 'organisation.member_invited',
        entityType: 'organisation_invitation',
        entityId: id,
        after: { role: args.role, expires_at: expiresAt },
        organisationId: args.organisationId,
      }),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return { ok: false, code: 'already_invited' };
    throw e;
  }

  const org = await env.DB.prepare('SELECT name FROM organisations WHERE id = ?').bind(args.organisationId).first<{ name: string }>();
  await sendEmail(env, {
    to: email,
    template: 'organisation_invitation',
    dedupeKey: `${id}:organisation_invitation`,
    params: {
      customer_email: email,
      organisation_name: org?.name ?? '',
      inviter_name: args.invitedBy.full_name,
      invitation_role: args.role === 'manager' ? 'Organisation Manager' : 'Organisation Member',
      invitation_url: `${env.APP_BASE_URL}/invitations/${token}`,
      invitation_expiry: new Date(expiresAt).toLocaleDateString('en-GB', { timeZone: 'Europe/London', dateStyle: 'long' }),
      venue_name: await getSetting(env, 'venue_name'),
    },
  });
  return { ok: true, invitationId: id, token };
}

export interface InvitationView {
  id: string;
  organisation_id: string;
  organisation_name: string;
  email: string;
  role: OrganisationRole;
  status: string;
  expires_at: string;
}

/** Look up an invitation by its raw token. Expired pending invitations report status 'expired'. */
export async function findInvitation(env: Env, token: string): Promise<InvitationView | null> {
  const row = await env.DB.prepare(
    `SELECT i.id, i.organisation_id, o.name AS organisation_name, i.email, i.role, i.status, i.expires_at
     FROM organisation_invitations i JOIN organisations o ON o.id = i.organisation_id WHERE i.token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first<InvitationView>();
  if (!row) return null;
  if (row.status === 'pending' && row.expires_at <= now()) row.status = 'expired';
  return row;
}

export type RespondResult =
  | { ok: true; organisationId: string }
  | { ok: false; code: 'not_found' | 'wrong_recipient' | 'not_pending' };

/**
 * Accept or decline an invitation. The signed-in user's email must match the
 * invitation. The status guard makes the token single-use; membership is
 * created in the same batch only if this request claimed the invitation.
 * Invitations only ever create organisation memberships, never platform roles.
 */
export async function respondToInvitation(
  env: Env,
  args: { token: string; user: { id: string; email: string; roles?: readonly string[] }; action: 'accept' | 'decline' },
): Promise<RespondResult> {
  const inv = await findInvitation(env, args.token);
  if (!inv) return { ok: false, code: 'not_found' };
  if (inv.email !== args.user.email.toLowerCase()) return { ok: false, code: 'wrong_recipient' };
  if (inv.status !== 'pending') return { ok: false, code: 'not_pending' };

  const ts = now();
  const status = args.action === 'accept' ? 'accepted' : 'declined';
  const statements = [
    env.DB.prepare(
      `UPDATE organisation_invitations SET status = ?, responded_at = ?, responded_by = ?
       WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    ).bind(status, ts, args.user.id, inv.id, ts),
    auditStatement(
      env,
      {
        actor: userActor(args.user),
        action: args.action === 'accept' ? 'organisation.member_joined' : 'organisation.invitation_declined',
        entityType: 'organisation_invitation',
        entityId: inv.id,
        after: { status, role: inv.role },
        organisationId: inv.organisation_id,
      },
      { onlyIfChanged: true },
    ),
  ];
  if (args.action === 'accept') {
    statements.push(
      env.DB.prepare(
        `INSERT INTO organisation_memberships (organisation_id, user_id, role, created_at, updated_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM organisation_invitations WHERE id = ? AND status = 'accepted' AND responded_at = ? AND responded_by = ?)
         ON CONFLICT(organisation_id, user_id) DO NOTHING`,
      ).bind(inv.organisation_id, args.user.id, inv.role, ts, ts, inv.id, ts, args.user.id),
    );
  }
  const [claim] = await env.DB.batch(statements);
  if (claim.meta.changes !== 1) return { ok: false, code: 'not_pending' };
  return { ok: true, organisationId: inv.organisation_id };
}
