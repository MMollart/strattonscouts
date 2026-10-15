import type { Env } from './http';
import { newId, now } from './http';
import { abortIf, guardedBatch } from './txn';
import type { AdminRole } from '@shared/permissions';

const ADMIN_ROLE_IDS_SQL = `SELECT id FROM roles WHERE name IN ('super_admin', 'booking_admin', 'viewer')`;
const SUPER_ADMIN_COUNT_SQL = `(SELECT COUNT(DISTINCT ur.user_id) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'super_admin')`;

export type SetAdminRoleResult = { ok: true } | { ok: false; code: 'not_found' | 'last_super_admin' };

/**
 * Give a user exactly one administration role, or none (`null` revokes
 * access). The whole change is one guarded batch, so concurrent changes can
 * never leave the platform without an active Super Admin.
 */
export async function setAdminRole(
  env: Env,
  args: { userId: string; role: AdminRole | null; actorId: string },
): Promise<SetAdminRoleResult> {
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(args.userId).first();
  if (!user) return { ok: false, code: 'not_found' };

  const current = await env.DB.prepare(
    `SELECT r.name AS name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.name`,
  )
    .bind(args.userId)
    .all<{ name: string }>();
  const fromRole = current.results.map((r) => r.name).join(',') || null;
  const ts = now();

  const statements: D1PreparedStatement[] = [];
  if (args.role !== 'super_admin') {
    // Refuse to demote the last Super Admin.
    statements.push(
      abortIf(
        env,
        `EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.name = 'super_admin')
         AND ${SUPER_ADMIN_COUNT_SQL} <= 1`,
        args.userId,
      ),
    );
  }
  statements.push(
    env.DB.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role_id IN (${ADMIN_ROLE_IDS_SQL})`).bind(args.userId),
  );
  if (args.role) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO user_roles (user_id, role_id, granted_at, granted_by)
         SELECT ?, id, ?, ? FROM roles WHERE name = ?`,
      ).bind(args.userId, ts, args.actorId, args.role),
    );
  }
  statements.push(
    env.DB.prepare(
      'INSERT INTO admin_role_events (id, user_id, from_role, to_role, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(newId('are'), args.userId, fromRole, args.role, args.actorId, ts),
  );

  const result = await guardedBatch(env, statements);
  if (!result) return { ok: false, code: 'last_super_admin' };
  return { ok: true };
}
