import type { Env } from '../../_lib/http';
import { error, json, now } from '../../_lib/http';
import { passwordResetConfirmSchema } from '@shared/validation';
import { sha256Hex, hashPassword } from '../../_lib/crypto';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = passwordResetConfirmSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());

  const tokenHash = await sha256Hex(parsed.data.token);
  const reset = await env.DB.prepare(
    'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?',
  )
    .bind(tokenHash)
    .first<{ id: string; user_id: string; expires_at: string; used_at: string | null }>();

  if (!reset || reset.used_at || new Date(reset.expires_at).getTime() < Date.now()) {
    return error('Invalid or expired reset token', 400);
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const ts = now();
  // Claim the token first; the password change and session invalidation only
  // apply if this request was the one that consumed it.
  const [claim] = await env.DB.batch([
    env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?').bind(ts, reset.id, ts),
    env.DB.prepare(
      `UPDATE users SET password_hash = ?, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM password_resets WHERE id = ? AND used_at = ?)`,
    ).bind(passwordHash, ts, reset.user_id, reset.id, ts),
    // Invalidate existing sessions for safety.
    env.DB.prepare(
      'DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM password_resets WHERE id = ? AND used_at = ?)',
    ).bind(reset.user_id, reset.id, ts),
  ]);
  if (claim.meta.changes !== 1) return error('Invalid or expired reset token', 400);

  return json({ ok: true });
};
