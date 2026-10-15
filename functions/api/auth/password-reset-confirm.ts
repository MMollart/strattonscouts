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
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(passwordHash, ts, reset.user_id),
    env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').bind(ts, reset.id),
    // Invalidate existing sessions for safety.
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(reset.user_id),
  ]);

  return json({ ok: true });
};
