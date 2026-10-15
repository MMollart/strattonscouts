import type { Env } from '../../../_lib/http';
import { error, json, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { ASSET_SELECT, assetHistory, isUniqueViolation } from '../../../_lib/assets';
import { assetUpdateSchema } from '@shared/validation';

// Admin: one asset with its full assignment history.
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'assets.manage');
  if (user instanceof Response) return user;
  const id = String(params.id);
  const asset = await env.DB.prepare(`${ASSET_SELECT} WHERE a.id = ?`).bind(id).first();
  if (!asset) return error('Asset not found', 404);
  return json({ ...asset, history: await assetHistory(env, id) });
};

// Admin: edit an asset's details or status. An assigned asset's status only
// changes by recording its return, so the history stays complete.
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'assets.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, assetUpdateSchema);
  if (input instanceof Response) return input;
  const id = String(params.id);
  const current = await env.DB.prepare('SELECT asset_type_id, status FROM assets WHERE id = ?').bind(id).first<{ asset_type_id: string; status: string }>();
  if (!current) return error('Asset not found', 404);
  if (input.asset_type_id !== current.asset_type_id) {
    const type = await env.DB.prepare('SELECT is_active FROM asset_types WHERE id = ?').bind(input.asset_type_id).first<{ is_active: number }>();
    if (!type) return error('Unknown asset type', 400);
    if (!type.is_active) return error('This asset type has been retired', 400);
  }
  if (current.status === 'assigned' && input.status) {
    return error('This asset is on loan. Record its return first.', 409);
  }
  const status = input.status ?? current.status;
  try {
    // Guarded on the status read above, so an assignment or return made meanwhile is never overwritten.
    const res = await env.DB.prepare(
      'UPDATE assets SET asset_type_id = ?, name = ?, description = ?, reference = ?, status = ?, updated_at = ? WHERE id = ? AND status = ?',
    )
      .bind(input.asset_type_id, input.name, input.description, input.reference, status, now(), id, current.status)
      .run();
    if (res.meta.changes !== 1) return error('This asset changed meanwhile; reload and try again', 409);
  } catch (e) {
    if (isUniqueViolation(e)) return error('Another asset already has this serial or reference number', 409);
    throw e;
  }
  return json({ ok: true, status });
};
