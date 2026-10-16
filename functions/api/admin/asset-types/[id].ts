import type { Env } from '../../../_lib/http';
import { error, json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { isUniqueViolation } from '../../../_lib/assets';
import { assetTypeSchema } from '@shared/validation';
import { audited } from '../../../_lib/audit';

// Admin: rename, reorder or retire an asset type. Retired types keep their
// assets but cannot be chosen for new ones.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'assets.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, assetTypeSchema);
  if (input instanceof Response) return input;
  try {
    const res = await audited(env, { actor: user, action: 'asset.type_updated', table: 'asset_types', id: String(params.id) }, () =>
    env.DB.prepare('UPDATE asset_types SET name = ?, description = ?, sort_order = ?, is_active = ? WHERE id = ?')
        .bind(input.name, input.description, input.sort_order, input.is_active ? 1 : 0, String(params.id))
        .run());
    if (res.meta.changes !== 1) return error('Asset type not found', 404);
  } catch (e) {
    if (isUniqueViolation(e)) return error('An asset type with this name already exists', 409);
    throw e;
  }
  return json({ ok: true });
};
