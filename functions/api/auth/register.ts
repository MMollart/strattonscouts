import type { Env } from '../../_lib/http';
import { error, json, newId, now } from '../../_lib/http';
import { registerSchema } from '@shared/validation';
import { hashPassword, encryptAtRest } from '../../_lib/crypto';
import { createSession, sessionCookie, rateLimit, clientIp } from '../../_lib/auth';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const allowed = await rateLimit(env, clientIp(request), 'register', 10, 60 * 60 * 1000);
  if (!allowed) return error('Too many attempts, please try again later', 429);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());
  const { full_name, email, phone, password, category } = parsed.data;

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase())
    .first();
  if (existing) return error('An account with this email already exists', 409);

  const cat = await env.DB.prepare('SELECT id FROM pricing_categories WHERE name = ? AND is_active = 1')
    .bind(category)
    .first<{ id: string }>();
  if (!cat) return error('Invalid category', 400);

  const id = newId('usr');
  const passwordHash = await hashPassword(password);
  const phoneEncrypted = await encryptAtRest(phone, env.DATA_ENCRYPTION_KEY ?? '');
  const ts = now();

  await env.DB.prepare(
    'INSERT INTO users (id, email, full_name, phone_encrypted, password_hash, pricing_category_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, email.toLowerCase(), full_name, phoneEncrypted, passwordHash, cat.id, ts, ts)
    .run();

  const { token, maxAge } = await createSession(env, id);
  return json({ id, email: email.toLowerCase(), full_name, phone, pricing_category_id: cat.id, roles: [], permissions: [] }, {
    status: 201,
    headers: { 'set-cookie': sessionCookie(token, maxAge) },
  });
};
