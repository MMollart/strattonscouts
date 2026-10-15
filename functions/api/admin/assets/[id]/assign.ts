import type { Env } from '../../../../_lib/http';
import { error, json, newId, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { abortIf, guardedBatch } from '../../../../_lib/txn';
import { isUniqueViolation } from '../../../../_lib/assets';
import { assetAssignSchema } from '@shared/validation';
import { ASSET_ASSIGNABLE_STATUSES } from '@shared/assets';

const ASSIGNABLE = ASSET_ASSIGNABLE_STATUSES.map((s) => `'${s}'`).join(', ');

// Admin: lend an asset to a registered user. The status check, the history
// row and the status change commit together; the open-assignment index is a
// second guarantee that an asset is never with two people at once.
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const admin = await requirePermission(env, request, 'assets.manage');
  if (admin instanceof Response) return admin;
  const input = await parseBody(request, assetAssignSchema);
  if (input instanceof Response) return input;
  const assetId = String(params.id);

  const asset = await env.DB.prepare('SELECT status FROM assets WHERE id = ?').bind(assetId).first<{ status: string }>();
  if (!asset) return error('Asset not found', 404);
  if (!(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?').bind(input.user_id).first())) return error('User not found', 400);
  const refusal = (status: string) =>
    status === 'assigned'
      ? error('This asset is already assigned. Record its return first.', 409)
      : error(`A ${status} asset cannot be assigned`, 409);
  if (!(ASSET_ASSIGNABLE_STATUSES as readonly string[]).includes(asset.status)) return refusal(asset.status);

  const id = newId('asg');
  const ts = now();
  let done: unknown[] | null;
  try {
    done = await guardedBatch(env, [
      abortIf(env, `NOT EXISTS (SELECT 1 FROM assets WHERE id = ? AND status IN (${ASSIGNABLE}))`, assetId),
      env.DB.prepare(
        'INSERT INTO asset_assignments (id, asset_id, user_id, assigned_by, assigned_at, assign_notes) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(id, assetId, input.user_id, admin.id, ts, input.notes),
      env.DB.prepare("UPDATE assets SET status = 'assigned', updated_at = ? WHERE id = ?").bind(ts, assetId),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) done = null;
    else throw e;
  }
  if (!done) {
    const latest = await env.DB.prepare('SELECT status FROM assets WHERE id = ?').bind(assetId).first<{ status: string }>();
    return refusal(latest?.status ?? 'assigned');
  }
  return json({ id }, 201);
};
