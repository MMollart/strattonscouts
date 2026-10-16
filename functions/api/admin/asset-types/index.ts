import type { Env } from '../../../_lib/http';
import { error, json, newId, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { isUniqueViolation } from '../../../_lib/assets';
import { assetTypeSchema } from '@shared/validation';
import { audited } from '../../../_lib/audit';

// Admin: asset types, including retired ones, with how many assets use each.
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'assets.manage');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare(
    `SELECT t.id, t.name, t.description, t.sort_order, t.is_active,
            (SELECT COUNT(*) FROM assets a WHERE a.asset_type_id = t.id) AS asset_count
     FROM asset_types t ORDER BY t.sort_order, t.name`,
  ).all<Record<string, unknown>>();
  return json(rows.results.map((r) => ({ ...r, is_active: !!r.is_active })));
};

// Admin: add an asset type.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'assets.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, assetTypeSchema);
  if (input instanceof Response) return input;
  const id = newId('atype');
  try {
    await audited(env, { actor: user, action: 'asset.type_created', table: 'asset_types', id }, () =>
    env.DB.prepare('INSERT INTO asset_types (id, name, description, sort_order, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, input.name, input.description, input.sort_order, input.is_active ? 1 : 0, now())
        .run());
  } catch (e) {
    if (isUniqueViolation(e)) return error('An asset type with this name already exists', 409);
    throw e;
  }
  return json({ id }, 201);
};
