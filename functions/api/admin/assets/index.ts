import type { Env } from '../../../_lib/http';
import { error, json, newId, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { parseBody } from '../../../_lib/request';
import { ASSET_SELECT, isUniqueViolation } from '../../../_lib/assets';
import { assetSchema } from '@shared/validation';
import { ASSET_STATUSES } from '@shared/assets';

// Admin: the asset register. Filters: status, type_id, user_id (current
// holder) and q (name, reference or holder).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'assets.manage');
  if (user instanceof Response) return user;
  const url = new URL(request.url);
  const where: string[] = [];
  const binds: unknown[] = [];
  const status = url.searchParams.get('status');
  if (status) {
    if (!(ASSET_STATUSES as readonly string[]).includes(status)) return error('Unknown status', 400);
    where.push('a.status = ?');
    binds.push(status);
  }
  const typeId = url.searchParams.get('type_id');
  if (typeId) {
    where.push('a.asset_type_id = ?');
    binds.push(typeId);
  }
  const userId = url.searchParams.get('user_id');
  if (userId) {
    where.push('x.user_id = ?');
    binds.push(userId);
  }
  const q = url.searchParams.get('q')?.trim();
  if (q) {
    where.push("(a.name LIKE ? ESCAPE '\\' OR a.reference LIKE ? ESCAPE '\\' OR u.full_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    binds.push(like, like, like, like);
  }
  const rows = await env.DB.prepare(`${ASSET_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.sort_order, a.name LIMIT 1000`)
    .bind(...binds)
    .all();
  return json(rows.results);
};

// Admin: register an asset. New assets are available.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'assets.manage');
  if (user instanceof Response) return user;
  const input = await parseBody(request, assetSchema);
  if (input instanceof Response) return input;
  const type = await env.DB.prepare('SELECT is_active FROM asset_types WHERE id = ?').bind(input.asset_type_id).first<{ is_active: number }>();
  if (!type) return error('Unknown asset type', 400);
  if (!type.is_active) return error('This asset type has been retired', 400);
  const id = newId('asset');
  const ts = now();
  try {
    await env.DB.prepare(
      `INSERT INTO assets (id, asset_type_id, name, description, reference, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'available', ?, ?, ?)`,
    )
      .bind(id, input.asset_type_id, input.name, input.description, input.reference, user.id, ts, ts)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) return error('Another asset already has this serial or reference number', 409);
    throw e;
  }
  return json({ id }, 201);
};
