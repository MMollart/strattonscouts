import type { Env } from '../_lib/http';
import { error, json, now } from '../_lib/http';
import { getAuthUser } from '../_lib/auth';
import { toPublicUser } from '../_lib/users';
import { updateAccountSchema } from '@shared/validation';
import { encryptAtRest } from '../_lib/crypto';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  return json(await toPublicUser(env, user));
};

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = updateAccountSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());

  const phoneEncrypted = await encryptAtRest(parsed.data.phone, env.DATA_ENCRYPTION_KEY ?? '');
  await env.DB.prepare('UPDATE users SET full_name = ?, phone_encrypted = ?, updated_at = ? WHERE id = ?')
    .bind(parsed.data.full_name, phoneEncrypted, now(), user.id)
    .run();

  const refreshed = await getAuthUser(env, request);
  return json(await toPublicUser(env, refreshed!));
};
