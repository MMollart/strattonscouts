import type { Env } from '../../_lib/http';
import { error, json, newId, now } from '../../_lib/http';
import { passwordResetRequestSchema } from '@shared/validation';
import { randomToken, sha256Hex } from '../../_lib/crypto';
import { rateLimit, clientIp } from '../../_lib/auth';
import { sendEmail } from '../../_lib/email';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const allowed = await rateLimit(env, clientIp(request), 'password_reset', 5, 60 * 60 * 1000);
  if (!allowed) return error('Too many requests, please try again later', 429);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = passwordResetRequestSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());
  const email = parsed.data.email.toLowerCase();

  const user = await env.DB.prepare('SELECT id, full_name FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string; full_name: string }>();

  // Always return success to avoid leaking account existence.
  if (user) {
    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    const ts = now();
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      'INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(newId('pwr'), user.id, tokenHash, ts, expires)
      .run();
    const resetUrl = `${env.APP_BASE_URL}/reset-password?token=${token}`;
    await sendEmail(env, {
      to: email,
      template: 'password_reset',
      params: { customer_name: user.full_name, reset_url: resetUrl },
    });
  }

  return json({ ok: true });
};
