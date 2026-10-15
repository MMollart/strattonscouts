import type { Env } from './http';
import { decryptAtRest } from './crypto';
import type { AuthUser } from './auth';

export async function toPublicUser(env: Env, user: AuthUser): Promise<{
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  pricing_category_id: string;
  roles: string[];
  permissions: string[];
}> {
  const row = await env.DB.prepare('SELECT phone_encrypted FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ phone_encrypted: string | null }>();
  const phone = await decryptAtRest(row?.phone_encrypted ?? null, env.DATA_ENCRYPTION_KEY ?? '');
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    phone,
    pricing_category_id: user.pricing_category_id,
    roles: user.roles,
    permissions: user.permissions,
  };
}
