import type { Env } from '../../../../_lib/http';
import { error, json, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { parseBody } from '../../../../_lib/request';
import { abortIf, guardedBatch } from '../../../../_lib/txn';
import { assetReturnSchema } from '@shared/validation';
import { auditStatement } from '../../../../_lib/audit';

// Admin: close an asset's open assignment. The outcome says what came back:
// 'available' (returned in good order), 'damaged' (returned damaged) or
// 'lost' (reported lost, so it can no longer be lent).
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const admin = await requirePermission(env, request, 'assets.manage');
  if (admin instanceof Response) return admin;
  const input = await parseBody(request, assetReturnSchema);
  if (input instanceof Response) return input;
  const assetId = String(params.id);
  const asset = await env.DB.prepare('SELECT name FROM assets WHERE id = ?').bind(assetId).first<{ name: string }>();
  if (!asset) return error('Asset not found', 404);

  const ts = now();
  const done = await guardedBatch(env, [
    abortIf(env, 'NOT EXISTS (SELECT 1 FROM asset_assignments WHERE asset_id = ? AND returned_at IS NULL)', assetId),
    env.DB.prepare(
      'UPDATE asset_assignments SET returned_at = ?, returned_by = ?, return_notes = ?, outcome = ? WHERE asset_id = ? AND returned_at IS NULL',
    ).bind(ts, admin.id, input.notes, input.outcome, assetId),
    env.DB.prepare('UPDATE assets SET status = ?, updated_at = ? WHERE id = ?').bind(input.outcome, ts, assetId),
    auditStatement(env, {
      actor: admin,
      action: 'asset.returned',
      entityType: 'asset',
      entityId: assetId,
      entityLabel: asset.name,
      before: { status: 'assigned' },
      after: { status: input.outcome },
      reason: input.notes || null,
    }),
  ]);
  if (!done) return error('This asset is not currently assigned', 409);
  return json({ ok: true, status: input.outcome });
};
