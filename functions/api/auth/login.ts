import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { loginSchema } from '@shared/validation';
import { verifyPassword } from '../../_lib/crypto';
import { createSession, sessionCookie, rateLimit, clientIp } from '../../_lib/auth';
import { toPublicUser } from '../../_lib/users';
import type { RoleName } from '@shared/types';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());
  const email = parsed.data.email.toLowerCase();

  const allowed = await rateLimit(env, `${clientIp(request)}:${email}`, 'login', 10, 15 * 60 * 1000);
  if (!allowed) return error('Too many login attempts, please try again later', 429);

  const user = await env.DB.prepare(
    'SELECT id, email, full_name, pricing_category_id, password_hash FROM users WHERE email = ?',
  )
    .bind(email)
    .first<{ id: string; email: string; full_name: string; pricing_category_id: string; password_hash: string }>();

  // Always run a hash verification to reduce timing oracle on account existence.
  const ok = user ? await verifyPassword(parsed.data.password, user.password_hash) : false;
  if (!user || !ok) return error('Invalid email or password', 401);

  const roleRows = await env.DB.prepare(
    'SELECT r.name AS name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?',
  )
    .bind(user.id)
    .all<{ name: RoleName }>();

  const { token, maxAge } = await createSession(env, user.id);
  const publicUser = await toPublicUser(env, {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    pricing_category_id: user.pricing_category_id,
    roles: roleRows.results.map((r) => r.name),
  });
  return json(publicUser, { headers: { 'set-cookie': sessionCookie(token, maxAge) } });
};
