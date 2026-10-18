import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { hashPassword } from '../../../../_lib/crypto';
import { auditStatement } from '../../../../_lib/audit';
import { adminPasswordResetSchema } from '@shared/validation';

// Super Admin: set a new password for someone who cannot use the emailed
// reset link. Signs them out everywhere and cancels any reset links they
// already have, so only the new password works from now on.
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const actor = await requirePermission(env, request, 'admins.manage');
  if (actor instanceof Response) return actor;
  const userId = String(params.id);
  if (userId === actor.id) return error('Use "Forgot password" on the login page to change your own password', 400);

  const target = await env.DB.prepare('SELECT id, full_name FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; full_name: string }>();
  if (!target) return error('User not found', 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = adminPasswordResetSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());

  const passwordHash = await hashPassword(parsed.data.password);
  const ts = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(passwordHash, ts, userId),
    env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(ts, userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    auditStatement(env, {
      actor,
      action: 'user.password_reset',
      entityType: 'user',
      entityId: userId,
      entityLabel: target.full_name,
    }),
  ]);
  return json({ ok: true });
};
