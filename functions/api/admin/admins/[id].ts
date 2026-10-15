import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { setAdminRole } from '../../../_lib/admins';
import { adminRoleUpdateSchema } from '@shared/validation';

// Super Admin: assign, change or revoke (role: null) a user's administration role.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const actor = await requirePermission(env, request, 'admins.manage');
  if (actor instanceof Response) return actor;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = adminRoleUpdateSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());

  const result = await setAdminRole(env, { userId: String(params.id), role: parsed.data.role, actorId: actor.id });
  if (!result.ok) {
    return result.code === 'not_found'
      ? error('User not found', 404)
      : error('There must always be at least one Super Admin', 409, { code: result.code });
  }
  return json({ ok: true });
};
